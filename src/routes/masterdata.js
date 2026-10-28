const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/v1/customers
// Flutter calls this on login/refresh to cache the customer list locally for offline use.
router.get('/customers', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, card_code, card_name, address, latitude, longitude, radius_meters, default_warehouse
       FROM customers ORDER BY card_name`
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /customers failed:', err.message);
    res.status(500).json({ error: 'Could not load customers' });
  }
});

// GET /api/v1/items
// A database error must NEVER crash the server (an unhandled error in an async
// route kills Node). If the Phase 1 migration has not been run yet (missing
// on_hand / unit_weight columns) this falls back to the old column list, so the
// app keeps working - stock/weight just show 0 until the migration is run.
router.get('/items', requireAuth, async (req, res) => {
  try {
    let rows;
    try {
      ({ rows } = await pool.query(
        `SELECT i.id, i.item_code, i.item_name, i.price, i.uom, i.on_hand, i.unit_weight,
                COALESCE((SELECT json_object_agg(s.whs_code, s.on_hand)
                          FROM item_warehouse_stock s WHERE s.item_code = i.item_code), '{}'::json) AS stock
         FROM items i ORDER BY i.item_name`
      ));
    } catch (err) {
      // 42703 = column does not exist, 42P01 = item_warehouse_stock table does not exist yet
      if (err.code !== '42703' && err.code !== '42P01') throw err;
      console.warn('[items] on_hand/unit_weight/item_warehouse_stock missing - run sql/001_phase1.sql and sql/002_warehouse_stock.sql. Serving old columns.');
      ({ rows } = await pool.query(
        `SELECT id, item_code, item_name, price, uom FROM items ORDER BY item_name`
      ));
    }
    res.json(rows);
  } catch (err) {
    console.error('GET /items failed:', err.message);
    res.status(500).json({ error: 'Could not load items' });
  }
});

// GET /api/v1/discounts
// Customer-specific discount % per item (from SAP), cached by the app so the
// order screen can show the discount offline. Empty list if the table does not exist yet.
router.get('/discounts', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT card_code, item_code, discount_pct FROM customer_discounts`
    );
    res.json(rows);
  } catch (err) {
    if (err.code === '42P01') { // table does not exist yet
      console.warn('[discounts] customer_discounts missing - run sql/001_phase1.sql. Returning none.');
      return res.json([]);
    }
    console.error('GET /discounts failed:', err.message);
    res.status(500).json({ error: 'Could not load discounts' });
  }
});

module.exports = router;