// Web admin dashboard API  (/api/v1/admin/*)
// Roles (technical document, section 12):
//   admin      - everything: all data, users/roles, sync health with retry, audit log
//   supervisor - own TEAM only (employees whose manager_name = the supervisor's name):
//                attendance, sales reports, visit summary; sync health is PARTIAL
//                (counts + team's failed orders, no error text, no logs, no retry)
//   salesman   - no access (403)
const express = require('express');
const ExcelJS = require('exceljs');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const rules = require('../services/dailyRules');

const router = express.Router();
const TZ = process.env.REPORT_TZ || 'Asia/Karachi';
const ROLES = ['salesman', 'supervisor', 'admin'];

router.use(requireAuth, requireRole('admin', 'supervisor'));

// ------------------------------------------------------------ helpers
// Does a column exist yet? Only "yes" is remembered - a "no" is re-checked every time,
// so running a migration while the server is up takes effect immediately.
const colCache = new Set();
async function colExists(table, col) {
  const k = `${table}.${col}`;
  if (colCache.has(k)) return true;
  const { rows } = await pool.query(
    'SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name=$2', [table, col]);
  if (rows.length > 0) colCache.add(k);
  return rows.length > 0;
}

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
async function todayStr() {
  const { rows } = await pool.query(`SELECT to_char((now() AT TIME ZONE $1)::date,'YYYY-MM-DD') AS d`, [TZ]);
  return rows[0].d;
}
async function range(req) {
  const t = await todayStr();
  let from = isDate(req.query.from) ? req.query.from : t;
  let to = isDate(req.query.to) ? req.query.to : from;
  if (to < from) [from, to] = [to, from];
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  if (days > 93) { const e = new Error('Please choose a range of 93 days or less'); e.status = 400; throw e; }
  return { from, to, days, today: t };
}

// null = no restriction (admin); array = the only user ids this person may see
async function scopeIds(req) {
  if (req.user.role === 'admin') return null;
  const me = (await pool.query('SELECT name FROM users WHERE id=$1', [req.user.id])).rows[0];
  if (!me) return [];
  const { rows } = await pool.query(
    `SELECT id FROM users WHERE lower(trim(manager_name)) = lower(trim($1)) AND id <> $2`, [me.name, req.user.id]);
  return rows.map((r) => r.id);
}
// the user ids to filter by (null = all). Honors ?employee_id= but never widens the scope.
async function filterIds(req) {
  const scope = await scopeIds(req);
  const wanted = req.query.employee_id ? Number(req.query.employee_id) : null;
  if (wanted) {
    if (scope && !scope.includes(wanted)) return [];
    return [wanted];
  }
  return scope;
}
const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(`[admin] ${req.method} ${req.path} failed:`, err.message);
    res.status(500).json({ error: 'Could not load this report' });
  }
};

let auditWarned = false;
async function audit(req, action, entity, entityId, detail) {
  try {
    const me = (await pool.query('SELECT name FROM users WHERE id=$1', [req.user.id])).rows[0];
    await pool.query(
      `INSERT INTO audit_log (actor_id, actor_name, action, entity, entity_id, detail) VALUES ($1,$2,$3,$4,$5,$6)`,
      [req.user.id, me ? me.name : null, action, entity, String(entityId), detail ? JSON.stringify(detail) : null]);
  } catch (err) {
    if (!auditWarned) { auditWarned = true; console.warn('[admin] audit_log not available - run sql/003_admin_dashboard.sql. Actions are NOT being logged.', err.message); }
  }
}

// ------------------------------------------------------------ data fetchers
async function employeesIn(ids) {
  const params = []; let where = `role IN ('salesman','employee')`;
  if (ids) { params.push(ids); where += ` AND id = ANY($1::int[])`; }
  const { rows } = await pool.query(`SELECT id, name FROM users WHERE ${where} ORDER BY name`, params);
  return rows;
}

async function tableExists(name) {
  const { rows } = await pool.query('SELECT to_regclass($1) AS t', ['public.' + name]);
  return !!rows[0].t;
}
async function assertInScope(req, userId) {
  const ids = await scopeIds(req);
  if (ids && !ids.includes(Number(userId))) { const e = new Error('That record is outside your team'); e.status = 403; throw e; }
}

// Present / absent per employee per day, with window result (ATT-01), the 12:00 / 16:00 captures
// (ATT-03/04/05), mock-GPS flags excluded from scoring until reviewed (ATT-06) and approved corrections (ATT-07).
// "Absent" (ATT-02) is derived: no check-in record for that business day.
async function attendanceData(req) {
  const { from, to, today } = await range(req);
  const ids = await filterIds(req);
  const emps = await employeesIn(ids);
  const summary = { present: 0, out_of_range: 0, absent: 0, late: 0, flagged: 0 };
  if (emps.length === 0) return { from, to, rows: [], summary };
  const eids = emps.map((e) => e.id);
  const hasWin = await colExists('attendance', 'window_status');
  const hasMock = await colExists('attendance', 'mock_location');
  const hasRev = await colExists('attendance', 'mock_review');
  const { rows: recs } = await pool.query(
    `SELECT a.user_id, a.status, a.marked_at, a.check_out_at, a.km_traveled, a.orders_count, a.photo_url, c.card_name AS shop,
            ${hasWin ? 'a.window_status' : 'NULL::text'} AS window_status, ${hasMock ? 'a.mock_location' : 'FALSE'} AS mock,
            ${hasRev ? 'a.mock_review' : 'NULL::text'} AS mock_review,
            to_char(a.marked_at AT TIME ZONE $1,'YYYY-MM-DD') AS day
       FROM attendance a LEFT JOIN customers c ON c.id = a.customer_id
      WHERE (a.marked_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date AND a.user_id = ANY($4::int[])
      ORDER BY a.marked_at`, [TZ, from, to, eids]);
  const byKey = new Map();
  for (const r of recs) { const k = `${r.user_id}|${r.day}`; if (!byKey.has(k)) byKey.set(k, r); } // the first check-in of the day is the official one

  const capMap = new Map();
  if (await tableExists('attendance_captures')) {
    const { rows } = await pool.query(
      `SELECT user_id, to_char(capture_date,'YYYY-MM-DD') AS day, sequence, status, mock_location, review_status, reason_code
         FROM attendance_captures WHERE capture_date BETWEEN $1::date AND $2::date AND user_id = ANY($3::int[]) ORDER BY id`, [from, to, eids]);
    for (const c of rows) { const k = `${c.user_id}|${c.day}|${c.sequence}`; if (!capMap.has(k) || c.status === 'captured') capMap.set(k, c); }
  }
  const corrected = new Set();
  if (await tableExists('attendance_corrections')) {
    const { rows } = await pool.query(
      `SELECT user_id, to_char(correction_date,'YYYY-MM-DD') AS day FROM attendance_corrections
        WHERE status='approved' AND correction_date BETWEEN $1::date AND $2::date AND user_id = ANY($3::int[])`, [from, to, eids]);
    for (const c of rows) corrected.add(`${c.user_id}|${c.day}`);
  }

  const cfg = await rules.getSettings();
  const nowMin = rules.localMinutes(new Date());
  const fmtTime = (d) => (d ? new Date(d).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }) : '');
  const rows = [];
  for (let t = Date.parse(to); t >= Date.parse(from); t -= 86400000) {
    const day = new Date(t).toISOString().slice(0, 10);
    if (day > today) continue;
    for (const e of emps) {
      const r = byKey.get(`${e.id}|${day}`);
      const isCorrected = corrected.has(`${e.id}|${day}`);
      const status = r ? (r.status === 'present' ? 'present' : 'out_of_range') : (isCorrected ? 'present' : 'absent');
      summary[status]++;
      let window = r ? (r.window_status || '') : (isCorrected ? 'corrected' : '');
      if (r && isCorrected && r.window_status === 'late') window = 'corrected';
      if (window === 'late') summary.late++;
      const checkinFlag = !!(r && r.mock && r.mock_review !== 'accepted');

      const slot = (seq) => {
        if (!r) return '';
        const c = capMap.get(`${e.id}|${day}|${seq}`);
        if (c) return c.status; // captured | missed
        const due = rules.minutesOf(seq === 2 ? cfg.capture_noon : cfg.capture_evening);
        return day === today && nowMin < due ? 'due later' : 'missed';
      };
      const noon = slot(2), evening = slot(3);
      const capFlag = [2, 3].some((q) => { const c = capMap.get(`${e.id}|${day}|${q}`); return c && c.mock_location && c.review_status !== 'accepted'; });
      const flagged = checkinFlag || capFlag;
      if (flagged) summary.flagged++;

      let compliance = null;
      if (r) {
        let expected = 1, valid = checkinFlag ? 0 : 1;
        for (const q of [2, 3]) {
          const c = capMap.get(`${e.id}|${day}|${q}`); const st = q === 2 ? noon : evening;
          if (st === 'due later') continue;
          expected++;
          if (c && c.status === 'captured' && !(c.mock_location && c.review_status !== 'accepted')) valid++;
        }
        compliance = Math.round((valid / expected) * 100);
      }
      rows.push({
        day, employee: e.name, status, window, noon, evening, flagged, compliance,
        check_in: r ? fmtTime(r.marked_at) : '', check_out: r ? fmtTime(r.check_out_at) : '',
        shop: r ? r.shop || '' : '', km: r && r.km_traveled != null ? Number(r.km_traveled) : null,
        orders: r ? r.orders_count : null, photo: r ? r.photo_url || '' : '',
      });
    }
  }
  return { from, to, rows, summary };
}

// Secondary sales report (doc 9.1): shop, location, SKU quantities, weight, value
async function ordersData(req) {
  const { from, to } = await range(req);
  const ids = await filterIds(req);
  const hasW = await colExists('items', 'unit_weight');
  const hasSfa = await colExists('orders', 'sfa_order_no');
  const hasDel = await colExists('orders', 'delivery_status');
  const hasManual = await colExists('order_items', 'discount_manual');
  const params = [TZ, from, to]; let where = `(o.order_date AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date`;
  if (ids) { params.push(ids); where += ` AND o.user_id = ANY($4::int[])`; }
  const { rows } = await pool.query(
    `SELECT o.id, to_char(o.order_date AT TIME ZONE $1,'YYYY-MM-DD HH24:MI') AS order_date,
            ${hasSfa ? 'o.sfa_order_no' : 'NULL::text'} AS sfa_no, u.name AS employee, c.card_name AS shop, c.address AS location,
            o.total_amount AS value, o.sync_status, o.sap_doc_entry,
            ${hasDel ? 'o.delivery_status, o.sap_delivery_doc_num' : 'NULL::text AS delivery_status, NULL::int AS sap_delivery_doc_num'},
            ${hasManual ? '(SELECT BOOL_OR(oi.discount_manual) FROM order_items oi WHERE oi.order_id = o.id)' : 'FALSE'} AS manual_discount,
            (SELECT COALESCE(SUM(oi.quantity),0) FROM order_items oi WHERE oi.order_id = o.id) AS qty,
            ${hasW ? `(SELECT COALESCE(SUM(oi.quantity * COALESCE(i.unit_weight,0)),0) FROM order_items oi JOIN items i ON i.id=oi.item_id WHERE oi.order_id=o.id)` : '0'} AS weight_kg,
            (SELECT string_agg(i.item_code || ' x ' || oi.quantity::text, ', ' ORDER BY oi.id) FROM order_items oi JOIN items i ON i.id=oi.item_id WHERE oi.order_id=o.id) AS skus
       FROM orders o LEFT JOIN users u ON u.id=o.user_id LEFT JOIN customers c ON c.id=o.customer_id
      WHERE ${where} ORDER BY o.order_date DESC LIMIT 2000`, params);
  const num = (v) => Number(v) || 0;
  const out = rows.map((r) => ({ ...r, value: num(r.value), qty: num(r.qty), weight_kg: num(r.weight_kg) }));
  const totals = out.reduce((a, r) => ({ orders: a.orders + 1, qty: a.qty + r.qty, weight_kg: a.weight_kg + r.weight_kg, value: a.value + r.value }),
    { orders: 0, qty: 0, weight_kg: 0, value: 0 });
  return { from, to, rows: out, totals };
}

// Shop visit summary (doc 9.2). Visits are known from check-ins that matched a customer
// geofence plus customers that received an order that day (visit tracking comes later).
async function visitData(req) {
  const { from, to } = await range(req);
  const ids = await filterIds(req);
  const params = [TZ, from, to]; let a = '', o = '';
  if (ids) { params.push(ids); a = ' AND user_id = ANY($4::int[])'; o = ' AND user_id = ANY($4::int[])'; }
  const { rows } = await pool.query(
    `WITH ord AS (SELECT DISTINCT user_id, (order_date AT TIME ZONE $1)::date AS d, customer_id FROM orders
                   WHERE customer_id IS NOT NULL AND (order_date AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date${o}),
          v AS (SELECT user_id, (marked_at AT TIME ZONE $1)::date AS d, customer_id FROM attendance
                 WHERE customer_id IS NOT NULL AND (marked_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date${a}
                UNION SELECT user_id, d, customer_id FROM ord)
     SELECT u.name AS employee, to_char(v.d,'YYYY-MM-DD') AS day,
            COUNT(DISTINCT v.customer_id)::int AS visited, COUNT(DISTINCT ord.customer_id)::int AS productive
       FROM v JOIN users u ON u.id = v.user_id
       LEFT JOIN ord ON ord.user_id = v.user_id AND ord.d = v.d AND ord.customer_id = v.customer_id
      GROUP BY u.name, v.d ORDER BY v.d DESC, u.name`, params);
  const out = rows.map((r) => ({ ...r, non_productive: r.visited - r.productive }));
  const totals = out.reduce((t, r) => ({ visited: t.visited + r.visited, productive: t.productive + r.productive, non_productive: t.non_productive + r.non_productive }),
    { visited: 0, productive: 0, non_productive: 0 });
  return { from, to, rows: out, totals };
}

// ------------------------------------------------------------ endpoints
router.get('/me', wrap(async (req, res) => {
  const me = (await pool.query('SELECT id, name, role FROM users WHERE id=$1', [req.user.id])).rows[0];
  res.json({ id: req.user.id, name: me ? me.name : '', role: req.user.role });
}));

router.get('/employees', wrap(async (req, res) => { res.json(await employeesIn(await scopeIds(req))); }));

router.get('/overview', wrap(async (req, res) => {
  const t = await todayStr();
  const ids = await scopeIds(req);
  const emps = await employeesIn(ids);
  const eids = emps.map((e) => e.id);
  let present = 0, outOfRange = 0, ordersToday = 0, valueToday = 0;
  if (eids.length) {
    const { rows } = await pool.query(
      `SELECT status, COUNT(DISTINCT user_id)::int AS n FROM attendance
        WHERE (marked_at AT TIME ZONE $1)::date = $2::date AND user_id = ANY($3::int[]) GROUP BY status`, [TZ, t, eids]);
    for (const r of rows) { if (r.status === 'present') present = r.n; else outOfRange += r.n; }
    const o = (await pool.query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(total_amount),0) AS v FROM orders
        WHERE (order_date AT TIME ZONE $1)::date = $2::date AND user_id = ANY($3::int[])`, [TZ, t, eids])).rows[0];
    ordersToday = o.n; valueToday = Number(o.v);
  }
  const sync = (await pool.query(
    `SELECT sync_status, COUNT(*)::int AS n FROM orders ${ids ? 'WHERE user_id = ANY($1::int[])' : ''} GROUP BY sync_status`, ids ? [ids] : [])).rows;
  const s = { synced: 0, pending: 0, error: 0 }; for (const r of sync) if (r.sync_status in s) s[r.sync_status] = r.n;
  res.json({ date: t, employees: emps.length, present, out_of_range: outOfRange,
    absent: Math.max(emps.length - present - outOfRange, 0), orders_today: ordersToday, value_today: valueToday, sync: s });
}));

router.get('/attendance', wrap(async (req, res) => res.json(await attendanceData(req))));
router.get('/orders', wrap(async (req, res) => res.json(await ordersData(req))));
router.get('/visit-summary', wrap(async (req, res) => res.json(await visitData(req))));

// SAP sync health (doc 9.4) - admin: full detail; supervisor: partial
router.get('/sync-health', wrap(async (req, res) => {
  const ids = await scopeIds(req); const isAdmin = req.user.role === 'admin';
  const p = ids ? [ids] : []; const w = ids ? 'AND o.user_id = ANY($1::int[])' : '';
  const counts = (await pool.query(`SELECT o.sync_status, COUNT(*)::int AS n FROM orders o WHERE 1=1 ${w} GROUP BY o.sync_status`, p)).rows;
  const c = { synced: 0, pending: 0, error: 0 }; for (const r of counts) if (r.sync_status in c) c[r.sync_status] = r.n;
  const failed = (await pool.query(
    `SELECT o.id, to_char(o.order_date AT TIME ZONE '${TZ}','YYYY-MM-DD HH24:MI') AS order_date, u.name AS employee, cu.card_name AS shop,
            o.total_amount AS value ${isAdmin ? ', o.sync_error' : ''}
       FROM orders o LEFT JOIN users u ON u.id=o.user_id LEFT JOIN customers cu ON cu.id=o.customer_id
      WHERE o.sync_status='error' ${w} ORDER BY o.order_date DESC LIMIT 100`, p)).rows;
  const tsw = ids ? 'AND a.user_id = ANY($1::int[])' : '';
  const ts = (await pool.query(
    `SELECT COUNT(*) FILTER (WHERE a.sap_synced)::int AS synced,
            COUNT(*) FILTER (WHERE NOT a.sap_synced AND a.check_out_at IS NOT NULL AND a.sap_sync_error IS NOT NULL)::int AS failed,
            COUNT(*) FILTER (WHERE NOT a.sap_synced AND a.check_out_at IS NOT NULL AND a.sap_sync_error IS NULL)::int AS pending
       FROM attendance a WHERE 1=1 ${tsw}`, p)).rows[0];
  const out = { orders: c, timesheets: ts, failed_orders: failed.map((f) => ({ ...f, value: Number(f.value) || 0 })), can_retry: isAdmin };
  if (isAdmin) {
    out.recent_log = (await pool.query(
      `SELECT sync_type, status, records_processed, left(message, 200) AS message, to_char(ran_at,'YYYY-MM-DD HH24:MI') AS ran_at
         FROM sync_log ORDER BY id DESC LIMIT 20`)).rows;
    out.failed_timesheets = (await pool.query(
      `SELECT a.id, u.name AS employee, to_char(a.marked_at AT TIME ZONE '${TZ}','YYYY-MM-DD') AS day, left(a.sap_sync_error, 250) AS error
         FROM attendance a JOIN users u ON u.id=a.user_id
        WHERE NOT a.sap_synced AND a.check_out_at IS NOT NULL AND a.sap_sync_error IS NOT NULL ORDER BY a.marked_at DESC LIMIT 30`)).rows;
  }
  res.json(out);
}));

// Resolve a failed order by sending it back to the sync queue (admin only, audited)
router.post('/orders/:id/retry', requireRole('admin'), wrap(async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE orders SET sync_status='pending', sync_error=NULL WHERE id=$1 AND sync_status='error' RETURNING id, client_uuid`, [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Order not found or not in error state' });
  await audit(req, 'order_retry', 'order', rows[0].id, { client_uuid: rows[0].client_uuid });
  res.json({ ok: true, id: rows[0].id });
}));


// Create the SAP Delivery for a synced order. THIS TAKES STOCK OUT OF THE SAP WAREHOUSE (document 4.3:
// stock is deducted on delivery, not at order booking). Admin and supervisor only, audited.
router.post('/orders/:id/deliver', requireRole('admin', 'supervisor'), wrap(async (req, res) => {
  if (!(await colExists('orders', 'delivery_status'))) {
    console.error('[deliver] run sql/007_delivery.sql first');
    return res.status(503).json({ error: 'This feature is not set up yet.' });
  }
  const { rows } = await pool.query('SELECT id, sync_status, sap_doc_entry, delivery_status FROM orders WHERE id = $1', [Number(req.params.id)]);
  const o = rows[0];
  if (!o) return res.status(404).json({ error: 'Order not found.' });
  if (o.sync_status !== 'synced' || !o.sap_doc_entry) return res.status(409).json({ error: 'This order has not reached SAP yet, so it cannot be delivered.' });
  if (o.delivery_status === 'delivered') return res.status(409).json({ error: 'This order is already delivered.' });
  const sap = require('../services/sapService');
  try {
    const r = await sap.bridge.post('/deliver', { OrderDocEntry: Number(o.sap_doc_entry) }, { timeout: 60000 });
    const d = r.data || {};
    await pool.query(
      `UPDATE orders SET delivery_status='delivered', sap_delivery_doc_entry=$2, sap_delivery_doc_num=$3, delivered_at=NOW(), delivery_error=NULL WHERE id=$1`,
      [o.id, Number(d.DocEntry) || null, Number(d.DocNum) || null]);
    await audit(req, 'order_deliver', 'order', o.id, { sap_delivery_doc_entry: d.DocEntry, sap_delivery_doc_num: d.DocNum });
    // pull fresh stock so the app shows the reduced quantity soon (not fatal if it fails)
    sap.pullItems().catch((e) => console.error('[deliver] stock refresh failed:', e.message));
    return res.json({ ok: true, delivery_no: d.DocNum || null });
  } catch (e) {
    const raw = String((e.response && e.response.data && e.response.data.error) || e.message || '');
    console.error('[deliver] order ' + o.id + ' failed: ' + raw.slice(0, 600));
    await pool.query('UPDATE orders SET delivery_error=$2 WHERE id=$1', [o.id, raw.slice(0, 500)]).catch(() => {});
    let msg = 'SAP could not create the delivery. Please try again or ask support.';
    if (/already closed|no open lines/i.test(raw)) msg = 'This order is already closed in SAP (it may already be delivered there).';
    else if (/below zero|insufficient|negative|not enough/i.test(raw)) msg = 'There is not enough stock in the SAP warehouse for this delivery.';
    else if (/cancel/i.test(raw)) msg = 'This order is cancelled in SAP.';
    return res.status(409).json({ error: msg });
  }
}));


// ---------- SAP reports (read-only, straight from SAP through the bridge) ----------
// region-sales  : A/R INVOICES, from the client's saved query (PROVISIONAL - compare with the SAP report)
// the rest      : SALES ORDERS (what the SFA app books), consistent order analyses - NOT copies of the Crystal reports
const SAP_REPORTS = {
  'region-sales': 'Invoice Wise Region Sales',
  'monthly-sales': 'Monthly sales (orders)',
  'party-wise': 'Party wise sales (orders)',
  'customer-status': 'Monthly customer status (orders)',
  'order-lines': 'Order lines with brand (orders)',
};
function sapReportParams(req) {
  const q = req.query || {};
  const fail = (m) => { const e = new Error(m); e.user = true; return e; };
  const ok = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
  if (!ok(q.from) || !ok(q.to)) throw fail('Choose a From and To date.');
  if (new Date(q.to) < new Date(q.from)) throw fail('The To date is before the From date.');
  if ((new Date(q.to) - new Date(q.from)) / 86400000 > 400) throw fail('Please choose a range of 13 months or less.');
  const p = { from: q.from, to: q.to };
  for (const k of ['item', 'region', 'town', 'area', 'customer']) {
    const v = String(q[k] || '').trim().slice(0, 300);
    if (v) {
      if (!/^[A-Za-z0-9 _\-.,\/&()]+$/.test(v)) throw fail('A filter contains characters that are not allowed.');
      p[k] = v;
    }
  }
  return p;
}
async function fetchSapReport(req) {
  const name = String(req.params.name || '');
  if (!SAP_REPORTS[name]) { const e = new Error('Unknown report.'); e.user = true; throw e; }
  const sap = require('../services/sapService');
  const r = await sap.bridge.get('/report/' + name, { params: sapReportParams(req), timeout: 90000 });
  return r.data;
}
router.get('/sap-reports/:name', requireRole('admin', 'supervisor'), wrap(async (req, res) => {
  try { return res.json(await fetchSapReport(req)); }
  catch (e) {
    if (e.user) return res.status(400).json({ error: e.message });
    console.error('[sap report] ' + req.params.name + ' failed:', String((e.response && e.response.data && e.response.data.error) || e.message).slice(0, 500));
    return res.status(502).json({ error: 'SAP could not be reached' });
  }
}));
router.get('/sap-reports/:name/export', requireRole('admin', 'supervisor'), wrap(async (req, res) => {
  let d;
  try { d = await fetchSapReport(req); }
  catch (e) {
    if (e.user) return res.status(400).json({ error: e.message });
    console.error('[sap report] export ' + req.params.name + ' failed:', e.message);
    return res.status(502).json({ error: 'SAP could not be reached' });
  }
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet(SAP_REPORTS[req.params.name].slice(0, 28));
  ws.addRow(d.columns.map((c) => c.label)); ws.getRow(1).font = { bold: true };
  const sums = d.columns.map(() => 0);
  for (const r of d.rows) { ws.addRow(d.columns.map((c) => r[c.key])); d.columns.forEach((c, i) => { if (c.total) sums[i] += Number(r[c.key]) || 0; }); }
  if (d.columns.some((c) => c.total)) { const tr = ws.addRow(d.columns.map((c, i) => (i === 0 ? 'TOTAL' : (c.total ? sums[i] : '')))); tr.font = { bold: true }; }
  ws.columns.forEach((c) => { c.width = 16; });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="' + req.params.name + '.xlsx"');
  res.send(Buffer.from(await wb.xlsx.writeBuffer()));
}));

// ---------- users & roles (admin only) ----------
router.get('/users', requireRole('admin'), wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM users ORDER BY name');
  res.json(rows.map((u) => ({
    id: u.id, name: u.name, email: u.email, role: u.role, manager_name: u.manager_name || '',
    sap_code: u.sap_user_code || u.sap_sales_employee_code || '', designation: u.designation || '',
    is_active: u.is_active === undefined ? true : u.is_active, role_override: u.role_override || null,
  })));
}));

router.patch('/users/:id/role', requireRole('admin'), wrap(async (req, res) => {
  const role = String(req.body.role || '');
  if (!ROLES.includes(role)) return res.status(400).json({ error: `role must be one of: ${ROLES.join(', ')}` });
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'You cannot change your own role (so you can never lock yourself out)' });
  const before = (await pool.query('SELECT role FROM users WHERE id=$1', [id])).rows[0];
  if (!before) return res.status(404).json({ error: 'User not found' });
  await pool.query('UPDATE users SET role=$1 WHERE id=$2', [role, id]);
  if (await colExists('users', 'role_override')) await pool.query('UPDATE users SET role_override=$1 WHERE id=$2', [role, id]); // survives the SAP user sync
  await audit(req, 'role_change', 'user', id, { from: before.role, to: role });
  res.json({ ok: true });
}));

router.patch('/users/:id/manager', requireRole('admin'), wrap(async (req, res) => {
  const manager = String(req.body.manager_name || '').trim() || null;
  const id = Number(req.params.id);
  const before = (await pool.query('SELECT manager_name FROM users WHERE id=$1', [id])).rows[0];
  if (!before) return res.status(404).json({ error: 'User not found' });
  await pool.query('UPDATE users SET manager_name=$1 WHERE id=$2', [manager, id]);
  await audit(req, 'manager_change', 'user', id, { from: before.manager_name, to: manager });
  res.json({ ok: true });
}));

router.get('/audit', requireRole('admin'), wrap(async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT to_char(at AT TIME ZONE '${TZ}','YYYY-MM-DD HH24:MI') AS at, actor_name, action, entity, entity_id, detail
         FROM audit_log ORDER BY id DESC LIMIT 200`);
    res.json(rows);
  } catch (err) {
    if (err.code === '42P01') return res.json([]); // table not created yet
    throw err;
  }
}));

// ---------- ATT-06: mock-GPS flags awaiting review (supervisor: team, admin: all) ----------
router.get('/mock-flags', wrap(async (req, res) => {
  const { from, to } = await range(req);
  const ids = await filterIds(req);
  const out = [];
  const idsSql = ids ? ' AND x.user_id = ANY($4::int[])' : '';
  const p = ids ? [TZ, from, to, ids] : [TZ, from, to];
  if ((await colExists('attendance', 'mock_location')) && (await colExists('attendance', 'mock_review'))) {
    const { rows } = await pool.query(
      `SELECT x.id, u.name AS employee, to_char(x.marked_at AT TIME ZONE $1,'YYYY-MM-DD') AS day,
              to_char(x.marked_at AT TIME ZONE $1,'HH24:MI') AS time, x.latitude, x.longitude
         FROM attendance x JOIN users u ON u.id = x.user_id
        WHERE x.mock_location AND x.mock_review IS NULL AND (x.marked_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date${idsSql}
        ORDER BY x.marked_at DESC LIMIT 200`, p);
    rows.forEach((r) => out.push({ kind: 'checkin', label: 'Check-in', ...r }));
  }
  if (await tableExists('attendance_captures')) {
    const { rows } = await pool.query(
      `SELECT x.id, u.name AS employee, to_char(x.capture_date,'YYYY-MM-DD') AS day,
              to_char(x.captured_at AT TIME ZONE $1,'HH24:MI') AS time, x.latitude, x.longitude, x.sequence
         FROM attendance_captures x JOIN users u ON u.id = x.user_id
        WHERE x.mock_location AND x.review_status IS NULL AND x.capture_date BETWEEN $2::date AND $3::date${idsSql}
        ORDER BY x.captured_at DESC LIMIT 200`, p);
    rows.forEach((r) => out.push({ kind: 'capture', label: r.sequence === 2 ? '12:00 capture' : '16:00 capture', ...r }));
  }
  res.json(out);
}));
router.post('/mock-flags/:kind/:id/review', wrap(async (req, res) => {
  const decision = String(req.body.decision || '');
  if (!['accepted', 'rejected'].includes(decision)) return res.status(400).json({ error: 'decision must be accepted or rejected' });
  const isCheckin = req.params.kind === 'checkin';
  if (!isCheckin && req.params.kind !== 'capture') return res.status(400).json({ error: 'kind must be checkin or capture' });
  const table = isCheckin ? 'attendance' : 'attendance_captures';
  const col = isCheckin ? 'mock_review' : 'review_status';
  const owner = (await pool.query(`SELECT user_id FROM ${table} WHERE id=$1`, [req.params.id])).rows[0];
  if (!owner) return res.status(404).json({ error: 'Record not found' });
  await assertInScope(req, owner.user_id);
  await pool.query(`UPDATE ${table} SET ${col}=$1 WHERE id=$2`, [decision, req.params.id]);
  await audit(req, 'mock_gps_review', table, req.params.id, { decision });
  res.json({ ok: true });
}));

// ---------- 4.6 market photos ----------
router.get('/photos', wrap(async (req, res) => {
  const { from, to } = await range(req);
  const ids = await filterIds(req);
  const cfg = await rules.getSettings();
  const min = Number(cfg.min_market_photos) || 3;
  if (!(await tableExists('market_photos'))) return res.json({ from, to, min, rows: [], per_day: [], note: 'Run sql/004_daily_activity.sql to enable market photos.' });
  const params = [TZ, from, to]; let w = '';
  if (ids) { params.push(ids); w = ' AND m.user_id = ANY($4::int[])'; }
  const hasReasonCol = await colExists('market_photos', 'reason');
  const { rows } = await pool.query(
    `SELECT m.id, u.name AS employee, to_char(m.photo_date,'YYYY-MM-DD') AS day, to_char(m.taken_at AT TIME ZONE $1,'HH24:MI') AS time,
            m.latitude, m.longitude, m.photo_url AS url, m.mock_location AS mock, ${hasReasonCol ? 'm.reason' : 'NULL::text AS reason'}
       FROM market_photos m JOIN users u ON u.id = m.user_id
      WHERE m.photo_date BETWEEN $2::date AND $3::date${w} ORDER BY m.taken_at DESC LIMIT 500`, params);
  const per = new Map();
  for (const r of rows) { const k = `${r.employee}|${r.day}`; per.set(k, (per.get(k) || 0) + 1); }
  const per_day = [...per.entries()].map(([k, n]) => { const [employee, day] = k.split('|'); return { employee, day, count: n, ok: n >= min }; });
  res.json({ from, to, min, rows, per_day });
}));

// ---------- 5.2 / 5.3 morning session + visit summary, one row per employee per day ----------
async function dailyActivityData(req) {
  const { from, to } = await range(req);
  const ids = await filterIds(req);
  const names = new Map((await pool.query('SELECT id, name FROM users')).rows.map((u) => [u.id, u.name]));
  const map = new Map(); const get = (uid, d) => { const k = `${uid}|${d}`; if (!map.has(k)) map.set(k, { employee: names.get(uid) || String(uid), day: d, uid }); return map.get(k); };
  const scopeSql = ids ? ' AND user_id = ANY($3::int[])' : ''; const p = ids ? [from, to, ids] : [from, to];
  if (await tableExists('morning_sessions')) {
    for (const r of (await pool.query(`SELECT user_id, to_char(session_date,'YYYY-MM-DD') AS d, distributor_meeting, primary_order_status FROM morning_sessions
        WHERE session_date BETWEEN $1::date AND $2::date${scopeSql}`, p)).rows) Object.assign(get(r.user_id, r.d), { meeting: r.distributor_meeting ? 'Yes' : 'No', primary: r.primary_order_status });
  }
  if (await tableExists('visit_summaries')) {
    for (const r of (await pool.query(`SELECT user_id, to_char(summary_date,'YYYY-MM-DD') AS d, total_shops_visited, productive_shops, units_booked, market_visit_area,
        to_char(start_time AT TIME ZONE '${TZ}','HH24:MI') AS st, to_char(end_time AT TIME ZONE '${TZ}','HH24:MI') AS et FROM visit_summaries
        WHERE summary_date BETWEEN $1::date AND $2::date${scopeSql}`, p)).rows)
      Object.assign(get(r.user_id, r.d), { visited: r.total_shops_visited, productive: r.productive_shops, non_productive: r.total_shops_visited - r.productive_shops,
        units: Number(r.units_booked), area: r.market_visit_area || '', start: r.st || '', end: r.et || '' });
  }
  if (await tableExists('market_photos')) {
    for (const r of (await pool.query(`SELECT user_id, to_char(photo_date,'YYYY-MM-DD') AS d, COUNT(*)::int AS n FROM market_photos
        WHERE photo_date BETWEEN $1::date AND $2::date${scopeSql} GROUP BY user_id, photo_date`, p)).rows) get(r.user_id, r.d).photos = r.n;
  }
  const rows = [...map.values()].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : a.employee.localeCompare(b.employee)));
  return { from, to, rows };
}
router.get('/daily-activity', wrap(async (req, res) => res.json(await dailyActivityData(req))));

// ---------- location history (section 12: supervisor = team, admin = all) ----------
// One employee, one day: check-in, the 12:00 / 16:00 captures and the live-tracking points, in time order.
router.get('/location-history', wrap(async (req, res) => {
  const { from } = await range(req);
  const uid = Number(req.query.employee_id);
  if (!uid) return res.status(400).json({ error: 'Choose an employee' });
  await assertInScope(req, uid);
  const t = (col) => `to_char(${col} AT TIME ZONE '${TZ}','HH24:MI:SS')`;
  const points = [];
  (await pool.query(`SELECT ${t('marked_at')} AS time, marked_at AS ts, latitude, longitude FROM attendance
                      WHERE user_id=$1 AND (marked_at AT TIME ZONE $2)::date = $3::date`, [uid, TZ, from]))
    .rows.forEach((r) => points.push({ ...r, source: 'Check-in' }));
  if (await tableExists('attendance_captures')) {
    (await pool.query(`SELECT ${t('captured_at')} AS time, captured_at AS ts, latitude, longitude, sequence FROM attendance_captures
                        WHERE user_id=$1 AND capture_date=$2::date AND status='captured'`, [uid, from]))
      .rows.forEach((r) => points.push({ ...r, source: r.sequence === 2 ? '12:00 capture' : '16:00 capture' }));
  }
  if (await tableExists('location_pings')) {
    (await pool.query(`SELECT ${t('recorded_at')} AS time, recorded_at AS ts, latitude, longitude FROM location_pings
                        WHERE user_id=$1 AND (recorded_at AT TIME ZONE $2)::date = $3::date ORDER BY recorded_at LIMIT 1500`, [uid, TZ, from]))
      .rows.forEach((r) => points.push({ ...r, source: 'Live tracking' }));
  }
  points.sort((a, b) => new Date(a.ts) - new Date(b.ts));
  res.json({ day: from, points: points.map(({ ts, sequence, ...p }) => ({ ...p, latitude: Number(p.latitude), longitude: Number(p.longitude) })) });
}));

// ---------- ATT-07 correction requests ----------
router.get('/corrections', wrap(async (req, res) => {
  if (!(await tableExists('attendance_corrections'))) return res.json([]);
  const ids = await scopeIds(req); const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  const { rows } = await pool.query(
    `SELECT c.id, u.name AS employee, to_char(c.correction_date,'YYYY-MM-DD') AS day, c.reason, c.status,
            to_char(c.requested_at AT TIME ZONE '${TZ}','YYYY-MM-DD HH24:MI') AS requested, c.decision_note
       FROM attendance_corrections c JOIN users u ON u.id = c.user_id
      WHERE c.status = $1 ${ids ? 'AND c.user_id = ANY($2::int[])' : ''} ORDER BY c.id DESC LIMIT 200`, ids ? [status, ids] : [status]);
  res.json(rows);
}));
router.post('/corrections/:id/decide', wrap(async (req, res) => {
  const decision = String(req.body.decision || '');
  if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'decision must be approved or rejected' });
  const c = (await pool.query('SELECT * FROM attendance_corrections WHERE id=$1', [req.params.id])).rows[0];
  if (!c) return res.status(404).json({ error: 'Request not found' });
  if (c.status !== 'pending') return res.status(409).json({ error: 'This request was already decided' });
  await assertInScope(req, c.user_id);
  if (c.user_id === req.user.id) return res.status(403).json({ error: 'You cannot decide your own request' });
  await pool.query('UPDATE attendance_corrections SET status=$1, decided_by=$2, decided_at=now(), decision_note=$3 WHERE id=$4',
    [decision, req.user.id, String(req.body.note || '').slice(0, 300) || null, c.id]);
  await audit(req, 'attendance_correction_' + decision, 'attendance_correction', c.id, { user_id: c.user_id, date: c.correction_date, note: req.body.note || null });
  res.json({ ok: true });
}));

// ---------- master data (admin only): shops, SKUs, sync now ----------
router.get('/shops', requireRole('admin'), wrap(async (req, res) => {
  if (!(await tableExists('shops'))) return res.json([]);
  const { rows } = await pool.query(
    `SELECT s.id, s.shop_code, s.name, s.mobile_no, s.address, s.area_town, s.status, u.name AS onboarded_by,
            to_char(s.created_at AT TIME ZONE '${TZ}','YYYY-MM-DD') AS created
       FROM shops s LEFT JOIN users u ON u.id = s.onboarded_by ORDER BY s.id DESC LIMIT 500`);
  res.json(rows);
}));
router.patch('/shops/:id', requireRole('admin'), wrap(async (req, res) => {
  const allowed = ['name', 'mobile_no', 'address', 'area_town', 'status']; const sets = []; const vals = []; const changes = {};
  for (const k of allowed) if (req.body[k] !== undefined) {
    const v = String(req.body[k]).trim();
    if (k === 'status' && !['active', 'inactive'].includes(v)) return res.status(400).json({ error: 'status must be active or inactive' });
    if (k === 'name' && !v) return res.status(400).json({ error: 'name cannot be empty' });
    if (k === 'mobile_no' && !/^\+?\d{7,15}$/.test(v.replace(/[\s-]/g, ''))) return res.status(400).json({ error: 'Enter a valid mobile number' });
    vals.push(v); sets.push(`${k}=$${vals.length}`); changes[k] = v;
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to change' });
  vals.push(req.params.id);
  const { rowCount } = await pool.query(`UPDATE shops SET ${sets.join(', ')} WHERE id=$${vals.length}`, vals);
  if (!rowCount) return res.status(404).json({ error: 'Shop not found' });
  await audit(req, 'shop_update', 'shop', req.params.id, changes);
  res.json({ ok: true });
}));
router.get('/skus', requireRole('admin'), wrap(async (req, res) => {
  const hasW = await colExists('items', 'unit_weight');
  const { rows } = await pool.query(
    `SELECT item_code, item_name, price, uom, ${hasW ? 'unit_weight' : '0::numeric'} AS unit_weight,
            to_char(last_synced_at,'YYYY-MM-DD HH24:MI') AS last_synced FROM items ORDER BY item_name LIMIT 3000`);
  res.json(rows.map((r) => ({ ...r, price: Number(r.price) || 0, unit_weight: Number(r.unit_weight) || 0 })));
}));
router.post('/sync/master-data', requireRole('admin'), wrap(async (req, res) => {
  try {
    const result = await require('../services/sapService').pullMasterData();
    await audit(req, 'master_data_sync', 'sap', 'now', result);
    res.json({ ok: true, ...result });
  } catch (err) {
    const msg = err.response ? JSON.stringify(err.response.data) : err.message;
    res.status(502).json({ error: 'SAP sync failed: ' + msg.slice(0, 300) });
  }
}));

// ---------- settings + SAP bridge status (admin only) ----------
const SETTING_RULES = {
  checkin_start: (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v), checkin_end: (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v),
  capture_noon: (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v), capture_evening: (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v),
  min_market_photos: (v) => /^\d{1,2}$/.test(v), enforce_market_photos: (v) => ['true', 'false'].includes(v),
  checkin_window_enforce: (v) => ['flag', 'off'].includes(v), rate_per_km: (v) => /^\d+(\.\d+)?$/.test(v),
  achieved_source: (v) => ['sfa', 'sap'].includes(v),
};
router.get('/settings', requireRole('admin'), wrap(async (req, res) => {
  const cfg = await rules.getSettings(true);
  res.json(Object.keys(SETTING_RULES).map((k) => ({ key: k, value: cfg[k] })));
}));
router.patch('/settings', requireRole('admin'), wrap(async (req, res) => {
  const { key } = req.body; const value = String(req.body.value === undefined ? '' : req.body.value).trim();
  if (!SETTING_RULES[key]) return res.status(400).json({ error: 'Unknown setting' });
  if (!SETTING_RULES[key](value)) return res.status(400).json({ error: `Invalid value for ${key}` });
  const before = (await rules.getSettings(true))[key];
  const upd = await pool.query('UPDATE app_settings SET value=$1, updated_at=now() WHERE key=$2', [value, key]);
  if (!upd.rowCount) await pool.query('INSERT INTO app_settings (key, value) VALUES ($1,$2)', [key, value]);
  rules.invalidateSettings();
  await audit(req, 'setting_change', 'setting', key, { from: before, to: value });
  res.json({ ok: true });
}));
router.get('/sap-status', requireRole('admin'), wrap(async (req, res) => {
  try {
    const r = await require('../services/sapService').bridge.get('/health', { timeout: 8000 });
    res.json({ reachable: true, sap_connected: !!(r.data && r.data.connected) });
  } catch (err) {
    res.json({ reachable: false, error: err.response ? `Bridge answered ${err.response.status}` : err.message });
  }
}));

// ---------- Excel export (doc 4.5 / 9: "exportable Excel/PDF") ----------
async function sendXlsx(res, name, columns, rows) {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet(name.slice(0, 30));
  ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width || 16 }));
  ws.getRow(1).font = { bold: true };
  rows.forEach((r) => ws.addRow(r));
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${name}.xlsx"`);
  res.send(Buffer.from(await wb.xlsx.writeBuffer()));
}
router.get('/export/orders', wrap(async (req, res) => {
  const d = await ordersData(req);
  await sendXlsx(res, `secondary_sales_${d.from}_to_${d.to}`, [
    { header: 'Date', key: 'order_date', width: 17 }, { header: 'SFA No', key: 'sfa_no' }, { header: 'Employee', key: 'employee', width: 22 },
    { header: 'Shop', key: 'shop', width: 28 }, { header: 'Location', key: 'location', width: 28 }, { header: 'SKUs', key: 'skus', width: 40 },
    { header: 'Qty', key: 'qty' }, { header: 'Weight (KG)', key: 'weight_kg' }, { header: 'Order Value', key: 'value' }, { header: 'SAP Sync', key: 'sync_status' },
  ], d.rows);
}));
router.get('/export/attendance', wrap(async (req, res) => {
  const d = await attendanceData(req);
  await sendXlsx(res, `attendance_${d.from}_to_${d.to}`, [
    { header: 'Date', key: 'day' }, { header: 'Employee', key: 'employee', width: 24 }, { header: 'Status', key: 'status' },
    { header: 'Check-in', key: 'check_in' }, { header: 'Check-in window', key: 'window' }, { header: '12:00 capture', key: 'noon' },
    { header: '16:00 capture', key: 'evening' }, { header: 'Compliance %', key: 'compliance' }, { header: 'Mock-GPS flag', key: 'flagged' },
    { header: 'Check-out', key: 'check_out' }, { header: 'Shop matched', key: 'shop', width: 26 }, { header: 'KM', key: 'km' }, { header: 'Orders', key: 'orders' },
  ], d.rows);
}));
router.get('/export/daily-activity', wrap(async (req, res) => {
  const d = await dailyActivityData(req);
  await sendXlsx(res, `daily_activity_${d.from}_to_${d.to}`, [
    { header: 'Date', key: 'day' }, { header: 'Employee', key: 'employee', width: 24 }, { header: 'Distributor meeting', key: 'meeting' },
    { header: 'Primary order', key: 'primary' }, { header: 'Shops visited', key: 'visited' }, { header: 'Productive', key: 'productive' },
    { header: 'Non-productive', key: 'non_productive' }, { header: 'Units booked', key: 'units' }, { header: 'Visit area', key: 'area', width: 22 },
    { header: 'Start', key: 'start' }, { header: 'End', key: 'end' }, { header: 'Market photos', key: 'photos' },
  ], d.rows);
}));
router.get('/export/visit-summary', wrap(async (req, res) => {
  const d = await visitData(req);
  await sendXlsx(res, `shop_visits_${d.from}_to_${d.to}`, [
    { header: 'Date', key: 'day' }, { header: 'Employee', key: 'employee', width: 24 },
    { header: 'Shops Visited', key: 'visited' }, { header: 'Productive', key: 'productive' }, { header: 'Non-productive', key: 'non_productive' },
  ], d.rows);
}));

// Allow admin to set a password for a user directly from the dashboard
router.post('/users/:id/password', requireRole('admin'), wrap(async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  const bcrypt = require('bcrypt');
  const hash = await bcrypt.hash(password, 10);
  
  const { rowCount } = await pool.query(
    'UPDATE users SET password_hash = $1 WHERE id = $2',
    [hash, req.params.id]
  );
  
  if (!rowCount) return res.status(404).json({ error: 'User not found' });
  await audit(req, 'user_password_change', 'user', req.params.id, {});
  res.json({ ok: true });
}));

module.exports = router;