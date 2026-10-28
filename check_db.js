// Save this file in your backend folder (next to .env) and run:   node check_db.js
// It connects EXACTLY the way your backend does and tells you which database that is
// and whether the Phase 1 migration is present in it. It changes nothing.
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.PGHOST, port: process.env.PGPORT,
  database: process.env.PGDATABASE, user: process.env.PGUSER, password: process.env.PGPASSWORD,
});
const has = async (table, col) =>
  Number((await pool.query(
    `SELECT count(*) c FROM information_schema.columns WHERE table_name=$1 AND column_name=$2`, [table, col])).rows[0].c) > 0;
(async () => {
  console.log('\nBackend .env says : host=%s port=%s database=%s user=%s',
    process.env.PGHOST, process.env.PGPORT, process.env.PGDATABASE, process.env.PGUSER);
  const info = (await pool.query(
    `SELECT current_database() AS db, inet_server_port() AS port, split_part(version(),' ',2) AS pg_version,
            (SELECT count(*) FROM customers) AS customers, (SELECT count(*) FROM orders) AS orders`)).rows[0];
  console.log('Actually connected: database=%s  server port=%s  PostgreSQL %s', info.db, info.port, info.pg_version);
  console.log('Data in THIS database: %s customers, %s orders', info.customers, info.orders);
  const checks = {
    'items.on_hand': await has('items', 'on_hand'),
    'items.unit_weight': await has('items', 'unit_weight'),
    'users.is_active': await has('users', 'is_active'),
    'users.sap_employee_id': await has('users', 'sap_employee_id'),
    'order_items.discount_pct': await has('order_items', 'discount_pct'),
  };
  const t = await pool.query(`SELECT to_regclass('public.customer_discounts') AS t`);
  checks['table customer_discounts'] = !!t.rows[0].t;
  for (const [k, v] of Object.entries(checks)) console.log('  %s %s', v ? 'OK     ' : 'MISSING', k);
  const missing = Object.values(checks).includes(false);
  console.log(missing
    ? '\nRESULT: migration is MISSING in the database your backend uses. Run 001_phase1.sql in THIS database (name/port shown above) - check the pgAdmin window you use is connected to the same port and database.'
    : '\nRESULT: migration is PRESENT in the database your backend uses. The database is fine - restart the backend (type rs in nodemon) and look elsewhere (backend not running / ngrok / app URL).');
  await pool.end();
})().catch(async (e) => { console.log('\nCOULD NOT CONNECT / QUERY:', e.message); process.exit(1); });