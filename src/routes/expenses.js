const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const VALID_TYPES = ['travel', 'ta_da', 'outstation', 'other', 'absence'];

// Total is always calculated server-side, never trusted purely from the
// client - one formula per expense_type.
function computeAmount(type, payload) {
  switch (type) {
    case 'travel':
      // Expense sheet row: mileage x rate + TA/DA + fuel + car allowance.
      // (older travel rows only have km and rate, so the extras are simply 0)
      return Number(payload.km || 0) * Number(payload.rate_per_km || 0)
        + Number(payload.ta_amount || 0) + Number(payload.da_amount || 0)
        + Number(payload.fuel_allowance || 0) + Number(payload.car_allowance || 0);
    case 'ta_da':
      return Number(payload.ta_amount || 0) + Number(payload.da_amount || 0);
    case 'outstation':
    case 'other':
      return Number(payload.amount || 0);
    case 'absence':
      return null; // absences have no monetary value
    default:
      return Number(payload.amount || 0);
  }
}

async function insertExpense(userId, payload) {
  const {
    client_uuid,
    expense_type = 'travel',
    from_latitude, from_longitude, to_latitude, to_longitude,
    km, rate_per_km,
    from_location, to_location, town, sub_town, area,
    start_date, end_date,
    nights, ta_amount, da_amount,
    category, absence_reason, remarks,
    detail, fuel_allowance, car_allowance,
    expense_date, created_offline,
  } = payload;

  if (!VALID_TYPES.includes(expense_type)) {
    throw Object.assign(new Error(`Invalid expense_type: ${expense_type}`), { statusCode: 400 });
  }

  const existing = await pool.query('SELECT id FROM expenses WHERE client_uuid = $1', [client_uuid]);
  if (existing.rows.length > 0) {
    return { client_uuid, status: 'already_synced', expense_id: existing.rows[0].id };
  }

  const total = computeAmount(expense_type, payload);
  const startDate = start_date || (expense_date ? expense_date.slice(0, 10) : null);
  const endDate = end_date || startDate;

  const baseValues = [
    client_uuid, userId, expense_type,
    from_latitude ?? null, from_longitude ?? null, to_latitude ?? null, to_longitude ?? null,
    km ?? null, rate_per_km ?? null,
    from_location ?? null, to_location ?? null, town ?? null, sub_town ?? null, area ?? null,
    startDate, endDate, nights ?? null, ta_amount ?? null, da_amount ?? null,
    category ?? null, absence_reason ?? null, remarks ?? null,
    total, expense_date || new Date(), !!created_offline,
  ];

  let result;
  try {
    result = await pool.query(
      `INSERT INTO expenses
        (client_uuid, user_id, expense_type,
         from_latitude, from_longitude, to_latitude, to_longitude, km, rate_per_km,
         from_location, to_location, town, sub_town, area,
         start_date, end_date, nights, ta_amount, da_amount,
         category, absence_reason, remarks, amount, expense_date, created_offline,
         detail, fuel_allowance, car_allowance)
       VALUES ($1,$2,$3, $4,$5,$6,$7,$8,$9, $10,$11,$12,$13,$14, $15,$16,$17,$18,$19,
               $20,$21,$22,$23,$24,$25, $26,$27,$28)
       RETURNING id`,
      [...baseValues, detail ?? null, fuel_allowance ?? null, car_allowance ?? null]
    );
  } catch (err) {
    if (err.code !== '42703') throw err; // 42703 = column does not exist
    // 002_expense_sheet.sql has not been run yet: save the row the old way so
    // nothing is lost and nothing crashes (detail/fuel/car are left out until then).
    console.warn('[expenses] detail/fuel_allowance/car_allowance columns missing - run sql/002_expense_sheet.sql');
    // keep the three new values in the existing `remarks` text so nothing is lost
    const extras = [detail, fuel_allowance ? `Fuel ${fuel_allowance}` : null, car_allowance ? `Car ${car_allowance}` : null]
      .filter(Boolean).join('; ');
    if (extras) baseValues[21] = [remarks, extras].filter(Boolean).join(' | ');
    result = await pool.query(
      `INSERT INTO expenses
        (client_uuid, user_id, expense_type,
         from_latitude, from_longitude, to_latitude, to_longitude, km, rate_per_km,
         from_location, to_location, town, sub_town, area,
         start_date, end_date, nights, ta_amount, da_amount,
         category, absence_reason, remarks, amount, expense_date, created_offline)
       VALUES ($1,$2,$3, $4,$5,$6,$7,$8,$9, $10,$11,$12,$13,$14, $15,$16,$17,$18,$19,
               $20,$21,$22,$23,$24,$25)
       RETURNING id`,
      baseValues
    );
  }
  return { client_uuid, status: 'saved', expense_id: result.rows[0].id, total_amount: total };
}

router.post('/', requireAuth, async (req, res) => {
  try {
    const result = await insertExpense(req.user.id, { ...req.body, created_offline: false });
    res.status(201).json(result);
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to save expense' });
  }
});

router.post('/sync-batch', requireAuth, async (req, res) => {
  try {
    const { expenses } = req.body;
    if (!Array.isArray(expenses)) return res.status(400).json({ error: 'expenses must be an array' });
    const results = [];
    for (const e of expenses) results.push(await insertExpense(req.user.id, { ...e }));
    res.json({ synced: results.length, results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Batch expense sync failed' });
  }
});

router.get('/', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM expenses WHERE user_id = $1 ORDER BY start_date DESC NULLS LAST, expense_date DESC LIMIT 100`,
    [req.user.id]
  );
  res.json(rows);
});

// GET /api/v1/expenses/settings - the company per-km rate, used to pre-fill the sheet.
router.get('/settings', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT value FROM app_settings WHERE key = 'rate_per_km'`);
    res.json({ rate_per_km: rows.length > 0 ? Number(rows[0].value) || 0 : 0 });
  } catch (err) {
    console.error('GET /expenses/settings failed:', err.message);
    res.json({ rate_per_km: 0 });
  }
});

module.exports = router;
// Reused by attendance.js so the automatic daily-mileage expense (From =
// check-in point, To = sign-out point) goes through the exact same
// insert/compute logic as every manually-entered expense - one source of
// truth for how a 'travel' amount gets calculated, no duplicated formula.
module.exports.insertExpense = insertExpense;