const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// POST /api/v1/tracking/ping -- a single live GPS point, sent periodically while tracking is active.
// This is intentionally lightweight (no dedupe/client_uuid needed) since pings are just a trail,
// not business documents like orders/attendance -- a duplicate ping doesn't cause harm.
router.post('/ping', requireAuth, async (req, res) => {
  try {
    const { latitude, longitude, recorded_at } = req.body;
    if (latitude == null || longitude == null || !recorded_at) {
      return res.status(400).json({ error: 'latitude, longitude, recorded_at are required' });
    }
    await pool.query(
      `INSERT INTO location_pings (user_id, latitude, longitude, recorded_at) VALUES ($1,$2,$3,$4)`,
      [req.user.id, latitude, longitude, recorded_at]
    );
    res.status(201).json({ status: 'ok' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save location ping' });
  }
});

// POST /api/v1/tracking/sync-batch -- flush a batch of pings queued while offline
router.post('/sync-batch', requireAuth, async (req, res) => {
  try {
    const { pings } = req.body;
    if (!Array.isArray(pings)) return res.status(400).json({ error: 'pings must be an array' });
    for (const p of pings) {
      await pool.query(
        `INSERT INTO location_pings (user_id, latitude, longitude, recorded_at) VALUES ($1,$2,$3,$4)`,
        [req.user.id, p.latitude, p.longitude, p.recorded_at]
      );
    }
    res.json({ synced: pings.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Batch tracking sync failed' });
  }
});

// GET /api/v1/tracking/today -- the day's route, e.g. for showing on a map in Reports later
router.get('/today', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT latitude, longitude, recorded_at FROM location_pings
     WHERE user_id = $1 AND recorded_at::date = CURRENT_DATE ORDER BY recorded_at ASC`,
    [req.user.id]
  );
  res.json(rows);
});

module.exports = router;