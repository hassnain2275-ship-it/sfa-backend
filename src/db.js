const { Pool, types } = require('pg');

// pg's default behavior returns NUMERIC/DECIMAL columns as JS strings, not
// numbers (done deliberately upstream to avoid floating-point precision
// loss on arbitrary-precision values). For this app, every NUMERIC column
// (km_traveled, prices, lat/lng, order totals, etc.) is a plain decimal
// number we want as a real JS number end-to-end - this fixes that at the
// actual root (the driver boundary), once, instead of needing defensive
// casts scattered across every route and every Flutter model field.
// OID 1700 = numeric/decimal.
types.setTypeParser(1700, (val) => (val === null ? null : parseFloat(val)));

require('dotenv').config();


const pool = new Pool({
  host: process.env.PGHOST,
  port: process.env.PGPORT,
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
});



pool.on('error', (err) => {
  console.error('Unexpected Postgres error', err);
});

module.exports = pool;