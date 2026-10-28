// Employee plans (targets + route grid) and the Plan vs Achieved report.  Mounted at /api/v1/plans
//   admin       - create / edit / cancel plans for anyone, see every plan and report
//   supervisor  - the same, for their own team only
//   employee    - read-only: own plan, own route, own Plan vs Achieved report
const express = require('express');
const PDFDocument = require('pdfkit');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const rules = require('../services/dailyRules');

const router = express.Router();
const { TZ } = rules;
router.use(requireAuth);

const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    if (err.code === '42P01' || err.code === '42703') {
      console.warn('[plans] database is missing the plans tables - run sql/005_plans.sql and sql/006_route_town.sql');
      return res.status(503).json({ error: 'Plans are not set up on the server yet (run 005_plans.sql and 006_route_town.sql).' });
    }
    console.error(`[plans] ${req.method} ${req.path} failed:`, err.message);
    res.status(500).json({ error: 'Could not complete the request' });
  }
};

// ---------------------------------------------------------------- helpers
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const day = (s) => Date.parse(`${s}T00:00:00Z`);
const daysBetween = (a, b) => Math.round((day(b) - day(a)) / 86400000) + 1;
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const money = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = (v) => (v == null ? '' : String(v).slice(0, 10));

async function todayStr() {
  return (await pool.query(`SELECT to_char((now() AT TIME ZONE $1)::date,'YYYY-MM-DD') AS d`, [TZ])).rows[0].d;
}
async function currentMonth() {
  const { rows } = await pool.query(
    `SELECT to_char(date_trunc('month', now() AT TIME ZONE $1)::date,'YYYY-MM-DD') AS f,
            to_char((date_trunc('month', now() AT TIME ZONE $1) + interval '1 month - 1 day')::date,'YYYY-MM-DD') AS t`, [TZ]);
  return { from: rows[0].f, to: rows[0].t };
}

// Which employees may this person see/manage?  null = everyone (admin)
async function allowedIds(req) {
  if (req.user.role === 'admin') return null;
  if (req.user.role === 'supervisor') {
    const me = (await pool.query('SELECT name FROM users WHERE id=$1', [req.user.id])).rows[0];
    const { rows } = await pool.query(`SELECT id FROM users WHERE lower(trim(manager_name)) = lower(trim($1))`, [me ? me.name : '']);
    return [...rows.map((r) => r.id), req.user.id];
  }
  return [req.user.id];
}
async function assertCanSee(req, userId) {
  const ids = await allowedIds(req);
  if (ids && !ids.includes(Number(userId))) throw bad('That employee is outside your team', 403);
}
let auditWarned = false;
async function audit(req, action, id, detail) {
  try {
    const me = (await pool.query('SELECT name FROM users WHERE id=$1', [req.user.id])).rows[0];
    await pool.query(`INSERT INTO audit_log (actor_id, actor_name, action, entity, entity_id, detail) VALUES ($1,$2,$3,'plan',$4,$5)`,
      [req.user.id, me ? me.name : null, action, String(id), detail ? JSON.stringify(detail) : null]);
  } catch (e) { if (!auditWarned) { auditWarned = true; console.warn('[plans] audit_log not available - run sql/003_admin_dashboard.sql'); } }
}

function validatePlan(b) {
  const name = String(b.name || '').trim();
  if (!name) throw bad('Plan name is required');
  if (!Number(b.user_id)) throw bad('Choose the employee');
  if (!isDate(b.period_from) || !isDate(b.period_to)) throw bad('From date and To date are required (YYYY-MM-DD)');
  if (day(b.period_to) < day(b.period_from)) throw bad('To date cannot be before From date');
  if (daysBetween(b.period_from, b.period_to) > 366) throw bad('A plan can cover at most one year');
  const t = {};
  for (const k of ['target_amount', 'target_qty', 'target_weight']) {
    const v = num(b[k]);
    if (v !== null && (!Number.isFinite(v) || v < 0)) throw bad(`${k.replace('_', ' ')} must be a number, 0 or more`);
    t[k] = v;
  }
  const routes = [];
  for (const [i, r] of (Array.isArray(b.routes) ? b.routes : []).entries()) {
    const empty = !r.from_location && !r.to_location && !r.area && !r.town && !r.remarks;
    if (empty && !r.route_date) continue; // blank grid row
    if (!isDate(r.route_date)) throw bad(`Route row ${i + 1}: a valid date is required`);
    if (day(r.route_date) < day(b.period_from) || day(r.route_date) > day(b.period_to)) throw bad(`Route row ${i + 1}: the date must be inside the plan period`);
    if (empty) throw bad(`Route row ${i + 1}: add a From location, To location or Area`);
    routes.push({ route_date: r.route_date, from_location: String(r.from_location || '').trim().slice(0, 120) || null,
      to_location: String(r.to_location || '').trim().slice(0, 120) || null, area: String(r.area || '').trim().slice(0, 120) || null,
      town: String(r.town || '').trim().slice(0, 120) || null,
      remarks: String(r.remarks || '').trim().slice(0, 300) || null });
  }
  return { name: name.slice(0, 120), user_id: Number(b.user_id), period_from: b.period_from, period_to: b.period_to, ...t, routes };
}

async function loadPlan(id) {
  const plan = (await pool.query(
    `SELECT p.*, u.name AS employee, to_char(p.period_from,'YYYY-MM-DD') AS pf, to_char(p.period_to,'YYYY-MM-DD') AS pt
       FROM plans p JOIN users u ON u.id = p.user_id WHERE p.id = $1`, [id])).rows[0];
  if (!plan) throw bad('Plan not found', 404);
  const routes = (await pool.query(
    `SELECT id, to_char(route_date,'YYYY-MM-DD') AS route_date, from_location, town, area, to_location, remarks
       FROM plan_routes WHERE plan_id = $1 ORDER BY route_date, sort_order, id`, [id])).rows;
  return { ...plan, period_from: plan.pf, period_to: plan.pt, routes };
}
const shape = (p) => ({ id: p.id, name: p.name, user_id: p.user_id, employee: p.employee, period_from: p.period_from, period_to: p.period_to,
  target_amount: p.target_amount == null ? null : Number(p.target_amount), target_qty: p.target_qty == null ? null : Number(p.target_qty),
  target_weight: p.target_weight == null ? null : Number(p.target_weight), status: p.status, source: p.source, routes: p.routes });

async function saveRoutes(client, planId, routes) {
  await client.query('DELETE FROM plan_routes WHERE plan_id=$1', [planId]);
  for (const [i, r] of routes.entries()) {
    await client.query(`INSERT INTO plan_routes (plan_id, route_date, from_location, to_location, area, town, remarks, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [planId, r.route_date, r.from_location, r.to_location, r.area, r.town, r.remarks, i]);
  }
}

// ---------------------------------------------------------------- plan management (admin / supervisor)
router.get('/', requireRole('admin', 'supervisor'), wrap(async (req, res) => {
  const ids = await allowedIds(req);
  const params = []; let where = '1=1';
  if (ids) { params.push(ids); where += ` AND p.user_id = ANY($${params.length}::int[])`; }
  if (req.query.employee_id) { await assertCanSee(req, req.query.employee_id); params.push(Number(req.query.employee_id)); where += ` AND p.user_id = $${params.length}`; }
  const { rows } = await pool.query(
    `SELECT p.id, p.name, u.name AS employee, p.user_id, to_char(p.period_from,'YYYY-MM-DD') AS period_from, to_char(p.period_to,'YYYY-MM-DD') AS period_to,
            p.target_amount, p.target_qty, p.target_weight, p.status, p.source,
            (SELECT COUNT(*)::int FROM plan_routes r WHERE r.plan_id = p.id) AS route_rows
       FROM plans p JOIN users u ON u.id = p.user_id WHERE ${where} ORDER BY p.period_from DESC, u.name LIMIT 500`, params);
  res.json(rows.map((r) => ({ ...r, target_amount: r.target_amount == null ? null : Number(r.target_amount),
    target_qty: r.target_qty == null ? null : Number(r.target_qty), target_weight: r.target_weight == null ? null : Number(r.target_weight) })));
}));

router.post('/', requireRole('admin', 'supervisor'), wrap(async (req, res) => {
  const v = validatePlan(req.body);
  await assertCanSee(req, v.user_id);
  if (!(await pool.query('SELECT 1 FROM users WHERE id=$1', [v.user_id])).rows.length) throw bad('Employee not found', 404);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO plans (name, user_id, period_from, period_to, target_amount, target_qty, target_weight, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [v.name, v.user_id, v.period_from, v.period_to, v.target_amount, v.target_qty, v.target_weight, req.user.id]);
    await saveRoutes(client, rows[0].id, v.routes);
    await client.query('COMMIT');
    await audit(req, 'plan_create', rows[0].id, { name: v.name, user_id: v.user_id, from: v.period_from, to: v.period_to, routes: v.routes.length });
    res.status(201).json({ id: rows[0].id });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}));


// ---------------------------------------------------------------- client's Excel route format
// Columns, in this order:  date | from | to | usercode | username | from location | town | area | to location
// date = the route date; from / to = the plan's period (first and last day); usercode / username = the employee.
const ROUTE_COLS = ['date', 'from', 'to', 'usercode', 'username', 'from location', 'town', 'area', 'to location'];
const ExcelJS = require('exceljs');

function cellValue(c) {
  let v = c && c.value;
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if (v.richText) v = v.richText.map((t) => t.text).join('');
    else if (v.result !== undefined) v = v.result;
    else if (v.text !== undefined) v = v.text;
  }
  return v == null ? '' : v;
}
function toIsoDate(v) {
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  if (typeof v === 'number' && v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
  const t = String(v || '').trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/); // day first, as used in Pakistan
  if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

async function sendRouteSheet(res, plan, user) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(ROUTE_COLS);
  ws.getRow(1).font = { bold: true };
  ws.columns.forEach((c, i) => { c.width = [12, 12, 12, 14, 20, 24, 18, 18, 24][i]; });
  if (plan) {
    const code = (user && (user.sap_user_code || user.email)) || '';
    for (const r of plan.routes) {
      ws.addRow([r.route_date, plan.period_from, plan.period_to, code, (user && user.name) || '', r.from_location || '', r.town || '', r.area || '', r.to_location || '']);
    }
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="route_plan${plan ? '_' + plan.id : '_format'}.xlsx"`);
  res.send(Buffer.from(await wb.xlsx.writeBuffer()));
}

router.get('/routes-template', requireRole('admin', 'supervisor'), wrap(async (req, res) => {
  if (req.query.plan_id) {
    const plan = await loadPlan(Number(req.query.plan_id));
    await assertCanSee(req, plan.user_id);
    const user = (await pool.query('SELECT * FROM users WHERE id=$1', [plan.user_id])).rows[0];
    return sendRouteSheet(res, plan, user);
  }
  return sendRouteSheet(res, null, null);
}));

// Reads an uploaded Excel file and returns the route rows. Nothing is saved here: the dashboard
// puts the rows into the plan form so the supervisor can check them and press Save.
router.post('/routes-parse', requireRole('admin', 'supervisor'), wrap(async (req, res) => {
  const b64 = String((req.body && req.body.file) || '');
  if (!b64) throw bad('No file was received.');
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(Buffer.from(b64, 'base64')); } catch (e) { console.error('[plans] route file unreadable:', e.message); throw bad('That file could not be read. Please upload an .xlsx file in the route plan format.'); }
  const ws = wb.worksheets[0];
  if (!ws) throw bad('The file has no sheet.');
  const col = {};
  ws.getRow(1).eachCell((c, i) => { col[String(cellValue(c)).trim().toLowerCase()] = i; });
  if (!col['date']) throw bad('Column "date" was not found in the first row. Use the route plan format: ' + ROUTE_COLS.join(', ') + '.');
  if (!col['from location'] && !col['to location'] && !col['area']) throw bad('Columns "from location", "to location" or "area" were not found.');
  let user = null;
  if (req.body.employee_id) {
    await assertCanSee(req, Number(req.body.employee_id));
    user = (await pool.query('SELECT * FROM users WHERE id=$1', [Number(req.body.employee_id)])).rows[0] || null;
  }
  const get = (row, name) => (col[name] ? cellValue(row.getCell(col[name])) : '');
  const text = (row, name) => String(get(row, name) === '' ? '' : get(row, name)).trim();
  const routes = []; const errors = [];
  for (let n = 2; n <= ws.rowCount; n++) {
    const row = ws.getRow(n);
    const raw = get(row, 'date');
    const f = text(row, 'from location'), t = text(row, 'to location'), a = text(row, 'area'), tw = text(row, 'town');
    if (raw === '' && !f && !t && !a && !tw) continue;
    const d = toIsoDate(raw);
    if (!d) { errors.push(`Row ${n}: the date "${String(raw)}" is not valid (use dd/mm/yyyy or yyyy-mm-dd).`); continue; }
    const code = text(row, 'usercode'), uname = text(row, 'username');
    if (user) {
      const myCode = String(user.sap_user_code || user.email || '').toLowerCase();
      if (code && myCode && code.toLowerCase() !== myCode) { errors.push(`Row ${n}: usercode "${code}" belongs to a different employee than the one selected.`); continue; }
      if (!code && uname && user.name && uname.toLowerCase() !== String(user.name).toLowerCase()) { errors.push(`Row ${n}: username "${uname}" belongs to a different employee than the one selected.`); continue; }
    }
    routes.push({ route_date: d, from_location: f, town: tw, area: a, to_location: t, remarks: '' });
  }
  if (!routes.length && !errors.length) throw bad('The file has no route rows.');
  res.json({ routes, errors });
}));

router.get('/mine', wrap(async (req, res) => {
  const today = await todayStr();
  const d = isDate(req.query.date) ? req.query.date : today;
  const plans = (await pool.query(
    `SELECT id FROM plans WHERE user_id=$1 AND status='active' AND $2::date BETWEEN period_from AND period_to ORDER BY period_from DESC`, [req.user.id, d])).rows;
  const out = [];
  for (const p of plans) out.push(shape(await loadPlan(p.id)));
  const routesToday = out.flatMap((p) => p.routes.filter((r) => r.route_date === d).map((r) => ({ ...r, plan: p.name })));
  const upcoming = out.flatMap((p) => p.routes.filter((r) => r.route_date > d && daysBetween(d, r.route_date) - 1 <= 10)  /* the next 10 days */.map((r) => ({ ...r, plan: p.name })))
    .sort((a, b) => (a.route_date < b.route_date ? -1 : 1));
  res.json({ date: d, plans: out.map(({ routes, ...p }) => p), routes_today: routesToday, routes_upcoming: upcoming });
}));

// ---------------------------------------------------------------- Plan vs Achieved
// Target = every active plan of the employee that overlaps the chosen dates, pro-rated by the
// number of overlapping days (a full-month plan with a full-month report = the exact target).
async function achievedFor(user, from, to) {
  return achievedFromApp(user.id, from, to);
}
// Achieved = orders booked in THIS app by the employee that have also reached SAP
// (sync_status = 'synced'). SAP orders entered any other way are never counted, and orders
// still waiting to sync are not counted until they arrive in SAP.
async function achievedFromApp(userId, from, to) {
  const hasW = (await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name='items' AND column_name='unit_weight'`)).rows.length > 0;
  const r = (await pool.query(
    `SELECT COUNT(DISTINCT o.id)::int AS orders, COALESCE(SUM(oi.line_total),0) AS amount, COALESCE(SUM(oi.quantity),0) AS qty,
            ${hasW ? 'COALESCE(SUM(oi.quantity * COALESCE(i.unit_weight,0)),0)' : '0'} AS weight
       FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id LEFT JOIN items i ON i.id = oi.item_id
      WHERE o.user_id = $1 AND o.sync_status = 'synced' AND (o.order_date AT TIME ZONE $2)::date BETWEEN $3::date AND $4::date`, [userId, TZ, from, to])).rows[0];
  const w = (await pool.query(
    `SELECT COUNT(*)::int AS n FROM orders o
      WHERE o.user_id = $1 AND o.sync_status <> 'synced' AND (o.order_date AT TIME ZONE $2)::date BETWEEN $3::date AND $4::date`, [userId, TZ, from, to])).rows[0];
  return { amount: Number(r.amount), qty: Number(r.qty), weight: Number(r.weight), orders: r.orders, waiting: w.n, source_used: 'sfa',
    note: w.n > 0 ? w.n + ' order(s) in these dates are not in SAP yet, so they are not counted until they sync.' : null };
}

async function reportData(req) {
  const cm = await currentMonth();
  const from = isDate(req.query.from) ? req.query.from : cm.from;
  const to = isDate(req.query.to) ? req.query.to : cm.to;
  if (day(to) < day(from)) throw bad('To date cannot be before From date');
  if (daysBetween(from, to) > 366) throw bad('Please choose a range of one year or less');
  const empId = req.query.employee_id ? Number(req.query.employee_id) : req.user.id;
  await assertCanSee(req, empId);
  const user = (await pool.query('SELECT * FROM users WHERE id=$1', [empId])).rows[0];
  if (!user) throw bad('Employee not found', 404);

  const plans = (await pool.query(
    `SELECT id FROM plans WHERE user_id=$1 AND status='active' AND period_from <= $3::date AND period_to >= $2::date ORDER BY period_from`, [empId, from, to])).rows;
  const target = { amount: null, qty: null, weight: null };
  const used = []; const routes = [];
  for (const p of plans) {
    const pl = await loadPlan(p.id);
    const o1 = day(pl.period_from) > day(from) ? pl.period_from : from;
    const o2 = day(pl.period_to) < day(to) ? pl.period_to : to;
    const factor = daysBetween(o1, o2) / daysBetween(pl.period_from, pl.period_to);
    for (const [k, col] of [['amount', 'target_amount'], ['qty', 'target_qty'], ['weight', 'target_weight']]) {
      if (pl[col] != null) target[k] = (target[k] || 0) + Number(pl[col]) * factor;
    }
    used.push({ name: pl.name, period_from: pl.period_from, period_to: pl.period_to, prorated: factor < 0.9999, share: Math.round(factor * 1000) / 10 });
    for (const r of pl.routes) if (day(r.route_date) >= day(from) && day(r.route_date) <= day(to)) routes.push({ ...r, plan: pl.name });
  }
  routes.sort((a, b) => (a.route_date < b.route_date ? -1 : a.route_date > b.route_date ? 1 : 0));
  const cfg = await rules.getSettings();
  const ach = await achievedFor(user, from, to);
  const achieved = { amount: ach.amount, qty: ach.qty, weight: ach.weight, orders: ach.orders };
  const r1 = (n) => Math.round(n * 10) / 10;
  const pct = {}; const remaining = {};
  for (const k of ['amount', 'qty', 'weight']) {
    pct[k] = target[k] > 0 ? r1((achieved[k] / target[k]) * 100) : null;
    remaining[k] = target[k] == null ? null : Math.max(target[k] - achieved[k], 0);
    if (target[k] != null) target[k] = Math.round(target[k] * 100) / 100;
  }
  const notes = [];
  if (!plans.length) notes.push('No active plan covers these dates for this employee.');
  if (used.some((u) => u.prorated)) notes.push('A plan only partly overlaps these dates, so its target is pro-rated by days.');
  if (ach.note) notes.push(ach.note);
  return { employee: { id: user.id, name: user.name }, from, to, plans: used, target, achieved, pct, remaining, routes,
    source: ach.source_used, notes };
}

router.get('/report', wrap(async (req, res) => {
  const d = await reportData(req);
  const format = String(req.query.format || 'json').toLowerCase();
  if (format === 'xlsx') return sendXlsx(res, d);
  if (format === 'pdf') return sendPdf(res, d);
  res.json(d);
}));

async function sendXlsx(res, d) {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Plan vs Achieved');
  ws.columns = [{ width: 22 }, { width: 18 }, { width: 18 }, { width: 14 }, { width: 18 }];
  ws.getCell('A1').value = 'Plan vs Achieved Report'; ws.getCell('A1').font = { bold: true, size: 14 };
  [['Employee Name', d.employee.name], ['From Date', d.from], ['To Date', d.to], ['Sales source', d.source === 'sap' ? 'SAP sales orders' : 'Orders booked in the app']]
    .forEach(([k, v], i) => { ws.getCell(`A${3 + i}`).value = k; ws.getCell(`A${3 + i}`).font = { bold: true }; ws.getCell(`B${3 + i}`).value = v; });
  const hr = 8; ['Measure', 'Target', 'Achieved', 'Achieved %', 'Remaining'].forEach((h, i) => { const c = ws.getCell(hr, i + 1); c.value = h; c.font = { bold: true }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7EEF8' } }; });
  [['Amount (Rs)', 'amount'], ['Quantity', 'qty'], ['Weight (KG)', 'weight']].forEach(([label, k], i) => {
    const r = hr + 1 + i; ws.getCell(r, 1).value = label; ws.getCell(r, 2).value = d.target[k] == null ? '' : d.target[k]; ws.getCell(r, 3).value = d.achieved[k];
    ws.getCell(r, 4).value = d.pct[k] == null ? '' : d.pct[k] / 100; ws.getCell(r, 4).numFmt = '0.0%'; ws.getCell(r, 5).value = d.remaining[k] == null ? '' : d.remaining[k];
    [2, 3, 5].forEach((c) => { ws.getCell(r, c).numFmt = '#,##0.00'; });
  });
  ws.getCell(hr + 4, 1).value = 'Orders booked'; ws.getCell(hr + 4, 3).value = d.achieved.orders;
  d.notes.forEach((n, i) => { ws.getCell(hr + 6 + i, 1).value = n; ws.getCell(hr + 6 + i, 1).font = { italic: true }; });
  const rs = wb.addWorksheet('Route Plan'); rs.columns = [{ width: 12 }, { width: 22 }, { width: 22 }, { width: 22 }, { width: 22 }, { width: 28 }];
  ['Date', 'Plan', 'From Location', 'To Location', 'Area', 'Remarks'].forEach((h, i) => { const c = rs.getCell(1, i + 1); c.value = h; c.font = { bold: true }; });
  d.routes.forEach((r) => rs.addRow([r.route_date, r.plan, r.from_location || '', r.to_location || '', r.area || '', r.remarks || '']));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="plan_vs_achieved_${d.from}_to_${d.to}.xlsx"`);
  res.send(Buffer.from(await wb.xlsx.writeBuffer()));
}
function sendPdf(res, d) {
  const doc = new PDFDocument({ size: 'A4', margin: 36 }); const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  doc.on('end', () => { res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `attachment; filename="plan_vs_achieved_${d.from}_to_${d.to}.pdf"`); res.send(Buffer.concat(chunks)); });
  doc.fontSize(16).font('Helvetica-Bold').text('Plan vs Achieved Report');
  doc.moveDown(0.5).fontSize(10).font('Helvetica').text(`Employee Name: ${d.employee.name}`).text(`From Date: ${d.from}     To Date: ${d.to}`)
    .text(`Sales source: ${d.source === 'sap' ? 'SAP sales orders' : 'Orders booked in the app'}`);
  doc.moveDown();
  const cols = [120, 100, 100, 80, 100]; let y = doc.y; const x0 = 36;
  const row = (vals, bold) => { let x = x0; doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9); vals.forEach((v, i) => { doc.rect(x, y, cols[i], 20).stroke('#999999'); doc.text(String(v), x + 4, y + 6, { width: cols[i] - 8, align: i ? 'right' : 'left', lineBreak: false }); x += cols[i]; }); y += 20; };
  row(['Measure', 'Target', 'Achieved', 'Achieved %', 'Remaining'], true);
  [['Amount (Rs)', 'amount'], ['Quantity', 'qty'], ['Weight (KG)', 'weight']].forEach(([l, k]) =>
    row([l, d.target[k] == null ? '-' : money(d.target[k]), money(d.achieved[k]), d.pct[k] == null ? '-' : d.pct[k] + '%', d.remaining[k] == null ? '-' : money(d.remaining[k])], false));
  doc.y = y + 10; doc.font('Helvetica').fontSize(9).text(`Orders booked: ${d.achieved.orders}`);
  d.notes.forEach((n) => doc.moveDown(0.3).font('Helvetica-Oblique').text(n));
  if (d.routes.length) {
    doc.moveDown().font('Helvetica-Bold').fontSize(11).text('Route Plan'); doc.moveDown(0.3).font('Helvetica').fontSize(9);
    d.routes.slice(0, 120).forEach((r) => doc.text(`${r.route_date}   ${r.from_location || '-'}  ->  ${r.to_location || '-'}   ${r.area ? '(' + r.area + ')' : ''}  ${r.remarks || ''}`));
  }
  doc.end();
}

// ---------------------------------------------------------------- single plan (declared last: '/:id' would swallow the fixed paths above)
router.get('/:id(\\d+)', requireRole('admin', 'supervisor'), wrap(async (req, res) => {
  const p = await loadPlan(req.params.id); await assertCanSee(req, p.user_id); res.json(shape(p));
}));
router.put('/:id(\\d+)', requireRole('admin', 'supervisor'), wrap(async (req, res) => {
  const old = await loadPlan(req.params.id); await assertCanSee(req, old.user_id);
  const v = validatePlan(req.body); await assertCanSee(req, v.user_id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE plans SET name=$1, user_id=$2, period_from=$3, period_to=$4, target_amount=$5, target_qty=$6, target_weight=$7, updated_at=now() WHERE id=$8`,
      [v.name, v.user_id, v.period_from, v.period_to, v.target_amount, v.target_qty, v.target_weight, old.id]);
    await saveRoutes(client, old.id, v.routes);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  await audit(req, 'plan_update', old.id, { name: v.name, from: v.period_from, to: v.period_to, routes: v.routes.length });
  res.json({ ok: true });
}));
router.post('/:id(\\d+)/cancel', requireRole('admin', 'supervisor'), wrap(async (req, res) => {
  const p = await loadPlan(req.params.id); await assertCanSee(req, p.user_id);
  await pool.query(`UPDATE plans SET status='cancelled', updated_at=now() WHERE id=$1`, [p.id]);
  await audit(req, 'plan_cancel', p.id, { name: p.name });
  res.json({ ok: true });
}));

module.exports = router;