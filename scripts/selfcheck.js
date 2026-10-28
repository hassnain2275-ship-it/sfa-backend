/*
 * SFA self-check: tells you what works and what does not, in one run.
 *
 *   cd backend
 *   node scripts/selfcheck.js
 *
 * To also test the dashboard's data (every tab) and login, type your admin login
 * in YOUR OWN terminal (never paste it into a chat):
 *   PowerShell:  $env:CHECK_USER="admin@example.com"; $env:CHECK_PASS="your-password"; node scripts/selfcheck.js
 *
 * It never prints passwords or API keys. Server-side error details stay in the backend console.
 */
const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch (_) {}

const results = [];
function line(status, name, extra) {
  results.push(status);
  const tag = status === 'PASS' ? '[ OK ]' : status === 'WARN' ? '[WARN]' : '[FAIL]';
  console.log(tag + ' ' + name + (extra ? '  -  ' + extra : ''));
}
function head(t) { console.log('\n== ' + t + ' =='); }
const short = (e) => String((e && e.message) || e).slice(0, 160);

async function env() {
  head('1. Settings (.env)');
  const must = ['PGHOST', 'PGDATABASE', 'PGUSER', 'JWT_SECRET', 'SAP_BRIDGE_URL', 'SAP_BRIDGE_API_KEY'];
  for (const k of must) line(process.env[k] ? 'PASS' : 'FAIL', k + (process.env[k] ? ' is set' : ' is MISSING'));
  console.log('      AUTH_MODE = ' + (process.env.AUTH_MODE || 'local (default)') +
    ' | time sheet sync = ' + (process.env.SAP_TIMESHEET_SYNC || 'on (default)'));
}

async function database() {
  head('2. Database');
  let pool;
  try { pool = require('../src/db'); await pool.query('SELECT 1'); line('PASS', 'Connected to PostgreSQL'); }
  catch (e) { line('FAIL', 'Cannot connect to PostgreSQL', short(e)); return; }
  const tables = ['users', 'customers', 'items', 'orders', 'order_items', 'attendance', 'expenses', 'sync_log',
    'customer_discounts', 'app_settings', 'audit_log', 'attendance_captures', 'attendance_corrections',
    'market_photos', 'morning_sessions', 'shops', 'visit_summaries', 'location_pings', 'plans', 'plan_routes'];
  const r = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
  const have = new Set(r.rows.map((x) => x.table_name));
  for (const t of tables) {
    if (have.has(t)) line('PASS', 'table ' + t);
    else line('FAIL', 'table ' + t + ' is missing', 'run the matching .sql migration (001..005)');
  }
  const cols = [['users', 'is_active'], ['users', 'sap_employee_id'], ['users', 'sap_sales_employee_code'], ['items', 'on_hand'], ['items', 'unit_weight'], ['order_items', 'discount_pct'], ['plan_routes', 'town']];
  for (const [t, c] of cols) {
    const q = await pool.query('SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name=$2', [t, c]);
    line(q.rowCount ? 'PASS' : 'FAIL', 'column ' + t + '.' + c, q.rowCount ? '' : (t === 'plan_routes' ? 'run 006_route_town.sql' : 'run 001_phase1.sql'));
  }
  try {
    const c = await pool.query("SELECT (SELECT count(*) FROM customers) AS customers, (SELECT count(*) FROM items) AS items, (SELECT count(*) FROM orders) AS orders, (SELECT count(*) FROM users) AS users");
    console.log('      rows: ' + JSON.stringify(c.rows[0]));
  } catch (_) {}
}

async function bridge() {
  head('3. SAP bridge (what comes from SAP)');
  const base = (process.env.SAP_BRIDGE_URL || '').replace(/\/+$/, '');
  const key = process.env.SAP_BRIDGE_API_KEY || '';
  if (!base || !key) { line('FAIL', 'SAP_BRIDGE_URL / SAP_BRIDGE_API_KEY not set'); return; }
  async function get(p) {
    const r = await fetch(base + p, { headers: { 'X-API-Key': key, 'ngrok-skip-browser-warning': '1' } });
    let j = null; try { j = await r.json(); } catch (_) {}
    return { status: r.status, body: j };
  }
  const count = (b) => Array.isArray(b) ? b.length : (b && typeof b === 'object' ? (['customers', 'items', 'discounts', 'users', 'rows', 'data'].map((k) => b[k]).find(Array.isArray) || []).length : 0);
  try {
    const h = await get('/health');
    if (h.status === 404 && /ngrok/i.test(base)) { line('WARN', 'SAP bridge is not running (ngrok answers 404 when nothing is behind it)', 'start DIAPIBridge.exe on the SAP server to test the SAP checks'); return; }
    line(h.status === 200 ? 'PASS' : 'FAIL', 'Bridge reachable and key accepted (/health)', 'HTTP ' + h.status);
    if (h.status !== 200) return;
  } catch (e) { line('FAIL', 'Cannot reach the bridge', short(e)); return; }
  for (const [p, label] of [['/customers', 'Customers from SAP (OCRD)'], ['/items', 'Items, price, weight, UoM from SAP (OITM)'],
    ['/discounts', 'Customer special prices from SAP (OSPP)'], ['/users', 'Users and employees from SAP (OUSR/OHEM)']]) {
    try {
      const r = await get(p); const n = count(r.body);
      line(r.status === 200 && n > 0 ? 'PASS' : (r.status === 200 ? 'WARN' : 'FAIL'), label, 'HTTP ' + r.status + ', ' + n + ' rows');
    } catch (e) { line('FAIL', label, short(e)); }
  }
  try {
    const d = new Date(); const to = d.toISOString().slice(0, 10); const from = to.slice(0, 8) + '01';
    const r = await get('/sales-summary?slpCode=20&from=' + from + '&to=' + to);
    line(r.status === 200 ? 'PASS' : 'FAIL', 'Sales totals from SAP orders (/sales-summary, SlpCode 20)', 'HTTP ' + r.status);
  } catch (e) { line('FAIL', 'sales-summary', short(e)); }
}

async function api() {
  head('4. Backend + web dashboard (every tab)');
  const port = process.env.PORT || 4000; const base = 'http://127.0.0.1:' + port;
  try { const h = await fetch(base + '/health'); line(h.ok ? 'PASS' : 'FAIL', 'Backend is running on port ' + port); if (!h.ok) return; }
  catch (e) { line('FAIL', 'Backend is NOT running on port ' + port, 'start it with npm start'); return; }
  try { const d = await fetch(base + '/admin/'); line(d.ok ? 'PASS' : 'FAIL', 'Dashboard page is served at /admin/'); } catch (e) { line('FAIL', 'Dashboard page', short(e)); }
  const user = process.env.CHECK_USER, pass = process.env.CHECK_PASS;
  if (!user || !pass) { line('WARN', 'Skipped the tab-by-tab test', 'set CHECK_USER and CHECK_PASS in your terminal (see top of this file)'); return; }
  let token;
  try {
    const r = await fetch(base + '/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: user, username: user, password: pass }) });
    const j = await r.json();
    if (!r.ok) { line('FAIL', 'Login', 'HTTP ' + r.status + ' ' + (j.error || '')); return; }
    token = j.token; line('PASS', 'Login works', 'role: ' + (j.user && j.user.role));
  } catch (e) { line('FAIL', 'Login', short(e)); return; }
  const d = new Date(); const to = d.toISOString().slice(0, 10); const from = to.slice(0, 8) + '01';
  const q = '?from=' + from + '&to=' + to + '&date=' + to + '&day=' + to;
  // The list of endpoints is read from the real route files, so nothing is guessed or forgotten.
  const fs = require('fs');
  const tabs = [];
  for (const [file, prefix] of [['admin.js', '/admin'], ['plans.js', '/plans']]) {
    try {
      const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', file), 'utf8');
      const re = /router\.get\('([^':]*)'/g; let m;
      while ((m = re.exec(src))) tabs.push([prefix + m[1], prefix + (m[1] === '/' ? '' : m[1])]);
    } catch (e) { line('WARN', 'Could not read ' + file, short(e)); }
  }
  for (const [name, p] of tabs) {
    if (/export|template/.test(p)) continue; // downloads are not checked here
    try {
      const r = await fetch(base + '/api/v1' + p + q, { headers: { authorization: 'Bearer ' + token } });
      let j = null; try { j = await r.json(); } catch (_) {}
      if (r.status >= 500) line('FAIL', 'Tab: ' + name, 'HTTP ' + r.status + (j && j.ref ? ' - look for [' + j.ref + '] in the backend console' : ''));
      else if (r.status >= 400) line('WARN', 'Tab: ' + name, 'HTTP ' + r.status + ' ' + ((j && j.error) || ''));
      else line('PASS', 'Tab: ' + name);
    } catch (e) { line('FAIL', 'Tab: ' + name, short(e)); }
  }
}

(async () => {
  console.log('SFA self-check  ' + new Date().toISOString());
  for (const step of [env, database, bridge, api]) { try { await step(); } catch (e) { line('FAIL', step.name, short(e)); } }
  const f = results.filter((x) => x === 'FAIL').length, w = results.filter((x) => x === 'WARN').length;
  console.log('\nResult: ' + results.filter((x) => x === 'PASS').length + ' ok, ' + w + ' warnings, ' + f + ' failed.');
  console.log(f ? 'Fix the [FAIL] lines first. Send me the full output if you need help.' : 'No failures.');
  try { await require('../src/db').end(); } catch (_) {}   // close the database cleanly (avoids a Windows exit assertion)
  process.exitCode = f ? 1 : 0;
})();