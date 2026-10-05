const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

async function insertOrder(userId, orderPayload) {
  const { client_uuid, customer_id, latitude, longitude, order_date, created_offline, items } = orderPayload;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT id FROM orders WHERE client_uuid = $1', [client_uuid]);
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return { client_uuid, status: 'already_synced', order_id: existing.rows[0].id };
    }
    const total = items.reduce((sum, i) => sum + Number(i.quantity) * Number(i.unit_price), 0);
    const orderResult = await client.query(
      `INSERT INTO orders (client_uuid, user_id, customer_id, latitude, longitude, total_amount, order_date, created_offline)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [client_uuid, userId, customer_id, latitude, longitude, total, order_date, !!created_offline]
    );
    const orderId = orderResult.rows[0].id;
    for (const line of items) {
      const lineTotal = Number(line.quantity) * Number(line.unit_price);
      await client.query(
        `INSERT INTO order_items (order_id, item_id, quantity, unit_price, line_total) VALUES ($1,$2,$3,$4,$5)`,
        [orderId, line.item_id, line.quantity, line.unit_price, lineTotal]
      );
    }
    await client.query('COMMIT');
    return { client_uuid, status: 'saved', order_id: orderId, sync_status: 'pending' };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

router.post('/', requireAuth, async (req, res) => {
  try {
    const result = await insertOrder(req.user.id, { ...req.body, created_offline: false });
    res.status(201).json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save order' });
  }
});

router.post('/sync-batch', requireAuth, async (req, res) => {
  try {
    const { orders } = req.body;
    if (!Array.isArray(orders)) return res.status(400).json({ error: 'orders must be an array' });
    const results = [];
    for (const o of orders) results.push(await insertOrder(req.user.id, { ...o }));
    res.json({ synced: results.length, results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Batch order sync failed' });
  }
});

router.get('/:client_uuid/status', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT client_uuid, sync_status, sap_doc_entry, sync_error, synced_at FROM orders WHERE client_uuid = $1`,
    [req.params.client_uuid]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Order not found' });
  res.json(rows[0]);
});

router.get('/', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT o.*, c.card_name FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
     WHERE o.user_id = $1 ORDER BY o.order_date DESC LIMIT 100`,
    [req.user.id]
  );
  res.json(rows);
});

module.exports = router;