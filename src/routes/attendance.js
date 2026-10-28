const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const { distanceMeters } = require('../utils/distance');
const { insertExpense } = require('./expenses');
const rules = require('../services/dailyRules');
const router = express.Router();

// Company-wide per-kilometer rate used for the automatic daily Travel
// expense (From = check-in point, To = sign-out point). Lives in the
// app_settings table, NOT in .env/code - change it any time with:
//   UPDATE app_settings SET value = '<new rate>' WHERE key = 'rate_per_km';
// No file edit, no backend restart, no APK rebuild, ever. Read fresh on
// every sign-out (sign-outs are infrequent - a once-per-signout lookup
// costs nothing, and freshness matters far more here than caching it).
async function getRatePerKm() {
  const { rows } = await pool.query(`SELECT value FROM app_settings WHERE key = 'rate_per_km'`);
  return rows.length > 0 ? Number(rows[0].value) || 0 : 0;
}

// Photos are stored on disk under backend/uploads/attendance-photos/ and
// served statically (see server.js) - kept simple, matching this project's
// current no-cloud-storage setup. Revisit if/when the backend moves to a
// proper host - a local folder won't survive a redeploy there.
const uploadDir = path.join(__dirname, '..', '..', 'uploads', 'attendance-photos');
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${req.user.id}_${Date.now()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB cap - phone photos, not full-res dumps
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Only image files are allowed'));
    cb(null, true);
  },
});

async function resolveAttendanceStatus(lat, lon) {
  const { rows: customers } = await pool.query('SELECT id, latitude, longitude, radius_meters FROM customers');
  let nearest = null;
  let nearestDistance = Infinity;
  for (const c of customers) {
    if (c.latitude == null || c.longitude == null) continue;
    const d = distanceMeters(lat, lon, Number(c.latitude), Number(c.longitude));
    if (d < nearestDistance) { nearestDistance = d; nearest = c; }
  }
  if (nearest && nearestDistance <= nearest.radius_meters) return { status: 'present', customerId: nearest.id };
  return { status: 'out_of_range', customerId: null };
}

async function insertAttendanceRecord(userId, record) {
  const { client_uuid, latitude, longitude, marked_at, created_offline, accuracy_m, mock_location } = record;

  // ATT-01: only the FIRST check-in of a business day is the official one. A second tap
  // (or a re-sent offline record) must not create another check-in for the same day.
  try {
    const { rows: first } = await pool.query(
      `SELECT * FROM attendance WHERE user_id = $1 AND client_uuid <> $4
          AND (marked_at AT TIME ZONE $2)::date = (($3::timestamptz) AT TIME ZONE $2)::date
        ORDER BY marked_at LIMIT 1`, [userId, rules.TZ, marked_at, client_uuid]);
    if (first[0]) return { ...first[0], already_checked_in: true };
  } catch (e) { console.warn('[attendance] same-day check skipped:', e.message); }

  const cfg = await rules.getSettings();
  const windowStatus = cfg.checkin_window_enforce === 'off' ? null : rules.windowStatusOf(marked_at, cfg);
  const { status, customerId } = await resolveAttendanceStatus(latitude, longitude);
  const base = [client_uuid, userId, customerId, latitude, longitude, status, marked_at, !!created_offline];

  let result;
  try {
    result = await pool.query(
      `INSERT INTO attendance (client_uuid, user_id, customer_id, latitude, longitude, status, marked_at, created_offline,
                               location_accuracy_m, mock_location, window_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (client_uuid) DO NOTHING RETURNING *`,
      [...base, accuracy_m ?? null, !!mock_location, windowStatus]);
  } catch (err) {
    if (err.code !== '42703') throw err; // 004_daily_activity.sql not run yet: save the old way, never lose a check-in
    console.warn('[attendance] accuracy/mock/window columns missing - run sql/004_daily_activity.sql');
    result = await pool.query(
      `INSERT INTO attendance (client_uuid, user_id, customer_id, latitude, longitude, status, marked_at, created_offline)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (client_uuid) DO NOTHING RETURNING *`, base);
  }
  return result.rows[0] || { client_uuid, status: 'already_synced' };
}

router.post('/mark', requireAuth, async (req, res) => {
  try {
    const { client_uuid, latitude, longitude, marked_at, accuracy_m, mock_location } = req.body;
    if (!client_uuid || latitude == null || longitude == null || !marked_at) {
      return res.status(400).json({ error: 'client_uuid, latitude, longitude, marked_at are required' });
    }
    const record = await insertAttendanceRecord(req.user.id, { client_uuid, latitude, longitude, marked_at, accuracy_m, mock_location, created_offline: false });
    res.status(201).json(record);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to mark attendance' });
  }
});

router.post('/sync-batch', requireAuth, async (req, res) => {
  try {
    const { records } = req.body;
    if (!Array.isArray(records)) return res.status(400).json({ error: 'records must be an array' });
    const results = [];
    for (const r of records) results.push(await insertAttendanceRecord(req.user.id, { ...r }));
    res.json({ synced: results.length, results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Batch sync failed' });
  }
});

router.get('/today', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM attendance WHERE user_id = $1 AND marked_at::date = CURRENT_DATE ORDER BY marked_at DESC LIMIT 1`,
    [req.user.id]
  );
  res.json(rows[0] || null);
});

// used by the Reports module
router.get('/history', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.*, c.card_name FROM attendance a LEFT JOIN customers c ON c.id = a.customer_id
     WHERE a.user_id = $1 ORDER BY a.marked_at DESC LIMIT 100`,
    [req.user.id]
  );
  res.json(rows);
});

// ---------------------------------------------------------------------
// POST /attendance/photo — pure photo submission. Does NOT record a
// checkout time or complete sign-out in any way. This exists purely so an
// employee who checked in but booked zero orders can explain why (empty
// stock, shop closed, etc.) before Sign Out (below) will let them leave.
// Requires an existing check-in today; does nothing to check-out state.
// ---------------------------------------------------------------------
router.post('/photo', requireAuth, upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'A photo file is required.' });
    }

    const { rows: todayRows } = await pool.query(
      `SELECT * FROM attendance WHERE user_id = $1 AND marked_at::date = CURRENT_DATE
       ORDER BY marked_at DESC LIMIT 1`,
      [req.user.id]
    );
    const todayRecord = todayRows[0];
    if (!todayRecord) {
      return res.status(400).json({ error: 'No check-in found for today - check in before uploading a photo.' });
    }

    const photoUrl = `/uploads/attendance-photos/${req.file.filename}`;
    const { rows } = await pool.query(
      `UPDATE attendance SET photo_url = $1 WHERE id = $2 RETURNING *`,
      [photoUrl, todayRecord.id]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('Photo upload failed:', err);
    res.status(500).json({ error: err.message || 'Photo upload failed' });
  }
});

// ---------------------------------------------------------------------
// POST /attendance/signout — the actual sign-out. No photo accepted here
// (multer intentionally not used on this route - photo goes through
// POST /attendance/photo, a separate action). Business rule: if zero
// orders were booked today AND no photo has already been submitted via
// /photo, sign-out is rejected with requiresPhoto: true so the app can
// send the user to upload one first, then retry.
// ---------------------------------------------------------------------
router.post('/signout', requireAuth, async (req, res) => {
  try {
    const { latitude, longitude } = req.body;
    if (latitude == null || longitude == null) {
      return res.status(400).json({ error: 'latitude and longitude are required' });
    }

    const { rows: todayRows } = await pool.query(
      `SELECT * FROM attendance WHERE user_id = $1 AND marked_at::date = CURRENT_DATE
       ORDER BY marked_at DESC LIMIT 1`,
      [req.user.id]
    );
    const todayRecord = todayRows[0];
    if (!todayRecord) {
      return res.status(400).json({ error: 'No check-in found for today - cannot sign out' });
    }
    if (todayRecord.check_out_at) {
      return res.status(400).json({ error: 'Already signed out today' });
    }

    const { rows: orderCountRows } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM orders WHERE user_id = $1 AND order_date::date = CURRENT_DATE`,
      [req.user.id]
    );
    const ordersCount = orderCountRows[0].count;

    // Business rule from the client: present but zero orders booked that
    // day requires an explanation photo (empty stock, shop closed, etc.)
    // uploaded via /attendance/photo before sign-out is allowed to complete.
    if (ordersCount === 0 && !todayRecord.photo_url) {
      return res.status(400).json({
        error: 'No orders were booked today - upload a photo explaining why in Attendance before you can sign out.',
        requiresPhoto: true,
      });
    }

    // 4.6: the day cannot be completed without the minimum number of market photos.
    // Off by default (setting enforce_market_photos) until everyone has the new app.
    const cfg = await rules.getSettings();
    if (cfg.enforce_market_photos === 'true') {
      const need = Number(cfg.min_market_photos) || 3;
      try {
        const { rows: pr } = await pool.query(
          `SELECT COUNT(*)::int AS n FROM market_photos WHERE user_id = $1 AND photo_date = (now() AT TIME ZONE $2)::date`,
          [req.user.id, rules.TZ]);
        if (pr[0].n < need) {
          return res.status(400).json({
            error: `Upload at least ${need} market photos before you sign out (you have ${pr[0].n}).`,
            requiresMarketPhotos: true, have: pr[0].n, need,
          });
        }
      } catch (e) { if (e.code !== '42P01') throw e; }
    }

    const kmTraveled = distanceMeters(
      Number(todayRecord.latitude), Number(todayRecord.longitude),
      Number(latitude), Number(longitude)
    ) / 1000;

    const { rows } = await pool.query(
      `UPDATE attendance
       SET check_out_at = NOW(), check_out_latitude = $1, check_out_longitude = $2,
           km_traveled = $3, orders_count = $4
       WHERE id = $5 RETURNING *`,
      [latitude, longitude, kmTraveled, ordersCount, todayRecord.id]
    );

    // Automatic daily Travel expense: From = check-in point, To = sign-out
    // point, same km just calculated above. This is a compulsory, automatic
    // part of sign-out - the employee never has to log today's mileage by
    // hand. TA/DA, Outstation, Absence and Other remain separate, manually
    // logged entries on top of this.
    if (kmTraveled > 0) {
      const ratePerKm = await getRatePerKm();
      if (ratePerKm > 0) {
        const { rows: dateRows } = await pool.query('SELECT CURRENT_DATE AS d');
        const todayStr = dateRows[0].d.toISOString().slice(0, 10);
        try {
          await insertExpense(req.user.id, {
            // Deterministic, not random - guarantees at most one auto-travel
            // entry per employee per day, however this route is invoked.
            client_uuid: `auto-travel-${req.user.id}-${todayStr}`,
            expense_type: 'travel',
            from_latitude: todayRecord.latitude,
            from_longitude: todayRecord.longitude,
            to_latitude: latitude,
            to_longitude: longitude,
            km: kmTraveled,
            rate_per_km: ratePerKm,
            start_date: todayStr,
            end_date: todayStr,
            remarks: 'Auto-calculated from check-in / sign-out GPS',
          });
        } catch (expenseErr) {
          // Sign-out itself must still succeed even if this side-effect
          // fails for some reason - just log it loudly so it's visible.
          console.error('Could not create automatic daily Travel expense:', expenseErr);
        }
      } else {
        console.warn(
          `[attendance] rate_per_km in app_settings is 0 (or missing) - skipped creating the automatic ` +
          `daily Travel expense for user_id=${req.user.id}. Run: UPDATE app_settings SET value = '<real rate>' WHERE key = 'rate_per_km';`
        );
      }
    }

    // 5.3: build today's market visit summary (best effort - never blocks the sign-out)
    try {
      await rules.saveVisitSummary(req.user.id, req.body.market_visit_area);
    } catch (e) {
      if (e.code !== '42P01' && e.code !== '42703') console.warn('[signout] visit summary not saved:', e.message);
    }

    res.json(rows[0]);
  } catch (err) {
    console.error('Sign-out failed:', err);
    res.status(500).json({ error: err.message || 'Sign-out failed' });
  }
});

module.exports = router;