// Daily-activity API: location captures (12:00 / 16:00), market photos, morning session,
// shop onboarding, attendance-correction requests, visit summary, app config.
// Mounted at /api/v1 so the paths match the document's section 8 (/attendance/location, /shops, /visits/summary).
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const rules = require('../services/dailyRules');

const router = express.Router();
const { TZ } = rules;

const photoDir = path.join(__dirname, '..', '..', 'uploads', 'market-photos');
fs.mkdirSync(photoDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, photoDir),
    filename: (req, file, cb) => cb(null, `${req.user.id}_${Date.now()}${path.extname(file.originalname) || '.jpg'}`),
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => (file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Only image files are allowed'))),
});

const fail = (res, err, what) => {
  if (err.status) return res.status(err.status).json({ error: err.message });
  if (err.code === '42P01' || err.code === '42703') {
    console.warn(`[daily] ${what}: database is missing the Phase 3 tables/columns - run sql/004_daily_activity.sql`);
    return res.status(503).json({ error: 'This feature is not set up on the server yet (run 004_daily_activity.sql).' });
  }
  console.error(`[daily] ${what} failed:`, err.message);
  res.status(500).json({ error: `${what} failed` });
};
const bad = (m) => Object.assign(new Error(m), { status: 400 });

// ---------------------------------------------------------------- config for the app
router.get('/attendance/config', requireAuth, async (req, res) => {
  const c = await rules.getSettings();
  res.json({
    checkin_start: c.checkin_start, checkin_end: c.checkin_end,
    capture_noon: c.capture_noon, capture_evening: c.capture_evening,
    min_market_photos: Number(c.min_market_photos) || 3,
    enforce_market_photos: c.enforce_market_photos === 'true',
    timezone: TZ, server_time: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------- ATT-03/04/05 captures
async function insertCapture(userId, c, offline) {
  const sequence = Number(c.sequence);
  if (![1, 2, 3].includes(sequence)) throw bad('sequence must be 1, 2 or 3');
  if (!c.client_uuid || !c.captured_at) throw bad('client_uuid and captured_at are required');
  const status = c.status === 'missed' ? 'missed' : 'captured';
  if (status === 'captured' && (c.latitude == null || c.longitude == null)) throw bad('latitude and longitude are required for a capture');
  if (status === 'missed' && !c.reason_code) throw bad('reason_code is required when a capture was missed');
  const day = rules.localDate(c.captured_at);

  const dup = await pool.query(
    `SELECT * FROM attendance_captures WHERE user_id=$1 AND capture_date=$2::date AND sequence=$3
       AND (status='captured' OR $4='missed') ORDER BY id LIMIT 1`, [userId, day, sequence, status]);
  if (dup.rows[0]) return { ...dup.rows[0], duplicate: true };

  const { rows } = await pool.query(
    `INSERT INTO attendance_captures (client_uuid, user_id, capture_date, sequence, status, reason_code, latitude, longitude,
                                      location_accuracy_m, captured_at, mock_location, created_offline)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (client_uuid) DO NOTHING RETURNING *`,
    [c.client_uuid, userId, day, sequence, status, c.reason_code || null, c.latitude ?? null, c.longitude ?? null,
     c.accuracy_m ?? null, c.captured_at, !!c.mock_location, !!offline]);
  return rows[0] || { client_uuid: c.client_uuid, status: 'already_synced' };
}
router.post('/attendance/location', requireAuth, async (req, res) => {
  try { res.status(201).json(await insertCapture(req.user.id, req.body, false)); } catch (e) { fail(res, e, 'Saving the location capture'); }
});
router.post('/attendance/location/sync-batch', requireAuth, async (req, res) => {
  try {
    if (!Array.isArray(req.body.records)) throw bad('records must be an array');
    const results = [];
    for (const r of req.body.records) results.push(await insertCapture(req.user.id, r, true));
    res.json({ synced: results.length, results });
  } catch (e) { fail(res, e, 'Batch location sync'); }
});

// ---------------------------------------------------------------- today's checklist for the app
router.get('/attendance/day-status', requireAuth, async (req, res) => {
  try {
    const uid = req.user.id; const cfg = await rules.getSettings();
    const d = (await pool.query(`SELECT to_char((now() AT TIME ZONE $1)::date,'YYYY-MM-DD') AS d`, [TZ])).rows[0].d;
    const q = async (sql, p) => { try { return (await pool.query(sql, p)).rows; } catch (e) { if (e.code === '42P01' || e.code === '42703') return []; throw e; } };
    const att = (await q(`SELECT id, marked_at, check_out_at, status FROM attendance
                          WHERE user_id=$1 AND (marked_at AT TIME ZONE $2)::date=$3::date ORDER BY marked_at LIMIT 1`, [uid, TZ, d]))[0] || null;
    // window_status exists only after sql/004 - read it separately so a missing column never hides the check-in
    if (att) { const w = (await q('SELECT window_status FROM attendance WHERE id=$1', [att.id]))[0]; att.window_status = w ? w.window_status : null; }
    const caps = await q(`SELECT sequence, status, reason_code FROM attendance_captures WHERE user_id=$1 AND capture_date=$2::date ORDER BY id`, [uid, d]);
    const photos = (await q(`SELECT COUNT(*)::int AS n FROM market_photos WHERE user_id=$1 AND photo_date=$2::date`, [uid, d]))[0];
    const morning = (await q(`SELECT distributor_meeting, primary_order_status FROM morning_sessions WHERE user_id=$1 AND session_date=$2::date`, [uid, d]))[0] || null;
    const summary = (await q(`SELECT market_visit_area FROM visit_summaries WHERE user_id=$1 AND summary_date=$2::date`, [uid, d]))[0] || null;
    const slot = (n) => { const c = caps.find((x) => x.sequence === n && x.status === 'captured') || caps.find((x) => x.sequence === n); return c ? (c.status === 'captured' ? 'captured' : 'missed') : null; };
    res.json({
      date: d, checked_in: !!att, window_status: att ? att.window_status : null, signed_out: !!(att && att.check_out_at),
      captures: { noon: slot(2), evening: slot(3) },
      photos: { count: photos ? photos.n : 0, min: Number(cfg.min_market_photos) || 3 },
      morning_session: morning, market_visit_area: summary ? summary.market_visit_area : null,
    });
  } catch (e) { fail(res, e, 'Loading the day status'); }
});

// ---------------------------------------------------------------- 4.6 market photos
router.post('/attendance/market-photo', requireAuth, upload.single('photo'), async (req, res) => {
  const discard = () => { if (req.file) fs.unlink(req.file.path, () => {}); };
  try {
    if (!req.file) throw bad('A photo file is required (camera photos only).');
    const b = req.body;
    if (!b.client_uuid || !b.taken_at) throw bad('client_uuid and taken_at are required');
    if (b.latitude == null || b.longitude == null || b.latitude === '' || b.longitude === '') throw bad('Photos must be geo-tagged (latitude and longitude).');
    const dup = await pool.query('SELECT * FROM market_photos WHERE client_uuid=$1', [b.client_uuid]);
    if (dup.rows[0]) { discard(); return res.json({ ...dup.rows[0], duplicate: true }); }
    const reason = String(b.reason || '').trim().slice(0, 500) || null;
    const hasReason = (await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name='market_photos' AND column_name='reason'`)).rows.length > 0;
    const baseVals = [b.client_uuid, req.user.id, rules.localDate(b.taken_at), b.taken_at, Number(b.latitude), Number(b.longitude),
       `/uploads/market-photos/${req.file.filename}`, b.shop_id ? Number(b.shop_id) : null, b.mock_location === 'true' || b.mock_location === true,
       b.created_offline === 'true'];
    const { rows } = hasReason
      ? await pool.query(
          `INSERT INTO market_photos (client_uuid, user_id, photo_date, taken_at, latitude, longitude, photo_url, shop_id, mock_location, created_offline, reason)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, [...baseVals, reason])
      : await pool.query(
          `INSERT INTO market_photos (client_uuid, user_id, photo_date, taken_at, latitude, longitude, photo_url, shop_id, mock_location, created_offline)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, baseVals);
    res.status(201).json(rows[0]);
  } catch (e) { discard(); fail(res, e, 'Uploading the market photo'); }
});

// ---------------------------------------------------------------- 5.2 morning session
router.post('/attendance/morning-session', requireAuth, async (req, res) => {
  try {
    const b = req.body;
    if (!b.client_uuid) throw bad('client_uuid is required');
    if (typeof b.distributor_meeting !== 'boolean') throw bad('distributor_meeting must be true or false');
    if (!['Placed', 'Pending', 'Not Applicable'].includes(b.primary_order_status)) throw bad('primary_order_status must be Placed, Pending or Not Applicable');
    const day = rules.localDate(b.recorded_at || new Date());
    const { rows } = await pool.query(
      `INSERT INTO morning_sessions (client_uuid, user_id, session_date, distributor_meeting, primary_order_status, recorded_at)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING *`,
      [b.client_uuid, req.user.id, day, b.distributor_meeting, b.primary_order_status, b.recorded_at || new Date().toISOString()]);
    if (rows[0]) return res.status(201).json(rows[0]);
    const ex = await pool.query('SELECT * FROM morning_sessions WHERE user_id=$1 AND session_date=$2::date', [req.user.id, day]); // first submission wins
    res.json({ ...ex.rows[0], duplicate: true });
  } catch (e) { fail(res, e, 'Saving the morning session'); }
});

// ---------------------------------------------------------------- 7.2 shops
router.get('/shops', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, shop_code, name, address, latitude, longitude, mobile_no, area_town FROM shops WHERE status='active' ORDER BY name`);
    res.json(rows);
  } catch (e) { if (e.code === '42P01') return res.json([]); fail(res, e, 'Loading shops'); }
});
router.post('/shops', requireAuth, async (req, res) => {
  try {
    const b = req.body;
    const name = String(b.name || '').trim(); const mobile = String(b.mobile_no || '').replace(/[\s-]/g, '');
    if (!name) throw bad('Shop name is required');
    if (!/^\+?\d{7,15}$/.test(mobile)) throw bad('Enter a valid mobile number (7-15 digits)');
    if (b.client_uuid) {
      const ex = await pool.query('SELECT * FROM shops WHERE client_uuid=$1', [b.client_uuid]);
      if (ex.rows[0]) return res.json({ ...ex.rows[0], duplicate: true });
    }
    const ins = await pool.query(
      `INSERT INTO shops (client_uuid, name, address, latitude, longitude, mobile_no, area_town, onboarded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [b.client_uuid || null, name, b.address || null, b.latitude ?? null, b.longitude ?? null, mobile, b.area_town || null, req.user.id]);
    const { rows } = await pool.query(`UPDATE shops SET shop_code = 'SHP-' || lpad(id::text, 4, '0') WHERE id=$1 RETURNING *`, [ins.rows[0].id]);
    res.status(201).json(rows[0]);
  } catch (e) { fail(res, e, 'Adding the shop'); }
});

// ---------------------------------------------------------------- ATT-07 correction requests (employee asks, supervisor/admin decides)
router.post('/attendance/corrections', requireAuth, async (req, res) => {
  try {
    const b = req.body;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.date || ''))) throw bad('date must be YYYY-MM-DD');
    if (!String(b.reason || '').trim()) throw bad('Please give a reason');
    if (b.client_uuid) {
      const ex = await pool.query('SELECT * FROM attendance_corrections WHERE client_uuid=$1', [b.client_uuid]);
      if (ex.rows[0]) return res.json({ ...ex.rows[0], duplicate: true });
    }
    const { rows } = await pool.query(
      `INSERT INTO attendance_corrections (client_uuid, user_id, correction_date, reason) VALUES ($1,$2,$3,$4) RETURNING *`,
      [b.client_uuid || null, req.user.id, b.date, String(b.reason).trim()]);
    res.status(201).json(rows[0]);
  } catch (e) { fail(res, e, 'Sending the correction request'); }
});
router.get('/attendance/corrections', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, to_char(correction_date,'YYYY-MM-DD') AS date, reason, status, decision_note
         FROM attendance_corrections WHERE user_id=$1 ORDER BY id DESC LIMIT 30`, [req.user.id]);
    res.json(rows);
  } catch (e) { if (e.code === '42P01') return res.json([]); fail(res, e, 'Loading correction requests'); }
});

// ---------------------------------------------------------------- 5.3 visit summary (area typed by the employee, the rest computed)
router.post('/visits/summary', requireAuth, async (req, res) => {
  try {
    const area = String(req.body.market_visit_area || '').trim();
    if (!area) throw bad('market_visit_area is required');
    res.json(await rules.saveVisitSummary(req.user.id, area));
  } catch (e) { fail(res, e, 'Saving the visit summary'); }
});

module.exports = router;