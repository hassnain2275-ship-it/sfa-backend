const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/v1/customers
// Flutter calls this on login/refresh to cache the customer list locally for offline use.
router.get('/customers', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, card_code, card_name, address, latitude, longitude, radius_meters
     FROM customers ORDER BY card_name`
  );
  res.json(rows);
});

// GET /api/v1/items
router.get('/items', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, item_code, item_name, price, uom FROM items ORDER BY item_name`
  );
  res.json(rows);
});

module.exports = router;
