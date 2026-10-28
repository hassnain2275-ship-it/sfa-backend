// Shared rules for the daily-activity features (technical document sections 3, 4.6, 5).
const pool = require('../db');
const TZ = process.env.REPORT_TZ || 'Asia/Karachi';

const DEFAULTS = {
  checkin_start: '09:00', checkin_end: '10:00',          // ATT-01
  capture_noon: '12:00', capture_evening: '16:00',       // ATT-03 / ATT-04
  min_market_photos: '3',                                // 4.6
  enforce_market_photos: 'false',                        // turn on from the dashboard Settings once everyone has the new app
  checkin_window_enforce: 'flag',                        // flag | off
  rate_per_km: '0',
  achieved_source: 'sfa',                                // sfa | sap - where the Plan vs Achieved report reads sales from
};

let cache = { at: 0, v: null };
async function getSettings(force = false) {
  if (!force && cache.v && Date.now() - cache.at < 15000) return cache.v;
  const v = { ...DEFAULTS };
  try {
    const { rows } = await pool.query('SELECT key, value FROM app_settings');
    for (const r of rows) v[r.key] = r.value;
  } catch (e) { /* settings table unreachable: use the defaults */ }
  cache = { at: Date.now(), v };
  return v;
}
const invalidateSettings = () => { cache.at = 0; };

const minutesOf = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + (m || 0); };
function localMinutes(d) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(d));
  return (Number(parts.find((p) => p.type === 'hour').value) % 24) * 60 + Number(parts.find((p) => p.type === 'minute').value);
}
function localDate(d) { return new Date(d).toLocaleDateString('en-CA', { timeZone: TZ }); }

// ATT-01: on_time = 09:00-10:00 (inclusive), early = before, late = after
function windowStatusOf(markedAt, cfg) {
  const t = localMinutes(markedAt);
  if (t < minutesOf(cfg.checkin_start)) return 'early';
  if (t > minutesOf(cfg.checkin_end)) return 'late';
  return 'on_time';
}

// 5.3 Market visit summary - computed from real data; only the area is typed by the employee.
async function saveVisitSummary(userId, area) {
  const d = (await pool.query(`SELECT to_char((now() AT TIME ZONE $1)::date,'YYYY-MM-DD') AS d`, [TZ])).rows[0].d;
  const ord = (await pool.query(
    `SELECT COUNT(DISTINCT o.customer_id)::int AS productive, COALESCE(SUM(oi.quantity),0) AS units
       FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id
      WHERE o.user_id = $1 AND (o.order_date AT TIME ZONE $2)::date = $3::date`, [userId, TZ, d])).rows[0];
  const visited = (await pool.query(
    `SELECT COUNT(*)::int AS n FROM (
        SELECT customer_id FROM orders WHERE user_id=$1 AND (order_date AT TIME ZONE $2)::date = $3::date
        UNION SELECT customer_id FROM attendance WHERE user_id=$1 AND (marked_at AT TIME ZONE $2)::date = $3::date) t
      WHERE customer_id IS NOT NULL`, [userId, TZ, d])).rows[0].n;
  const att = (await pool.query(
    `SELECT marked_at, check_out_at FROM attendance WHERE user_id=$1 AND (marked_at AT TIME ZONE $2)::date = $3::date
      ORDER BY marked_at LIMIT 1`, [userId, TZ, d])).rows[0];
  const { rows } = await pool.query(
    `INSERT INTO visit_summaries (user_id, summary_date, total_shops_visited, productive_shops, units_booked, market_visit_area, start_time, end_time)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (user_id, summary_date) DO UPDATE SET
       total_shops_visited = EXCLUDED.total_shops_visited, productive_shops = EXCLUDED.productive_shops,
       units_booked = EXCLUDED.units_booked, start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time,
       market_visit_area = COALESCE(EXCLUDED.market_visit_area, visit_summaries.market_visit_area)
     RETURNING *`,
    [userId, d, visited, ord.productive, Number(ord.units), area ? String(area).trim() : null,
     att ? att.marked_at : null, att ? att.check_out_at : null]);
  return rows[0];
}

module.exports = { TZ, getSettings, invalidateSettings, windowStatusOf, localDate, localMinutes, minutesOf, saveVisitSummary };
