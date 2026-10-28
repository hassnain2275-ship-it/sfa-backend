const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

// Largest discount an employee may type for a line (percent). Set MAX_DISCOUNT_PCT in .env to limit it.
const MAX_DISCOUNT_PCT = Math.min(100, Math.max(0, Number(process.env.MAX_DISCOUNT_PCT || 100)));
let hasManualCol = null;
async function manualColumnExists(client) {
  if (hasManualCol === null) {
    const r = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_name='order_items' AND column_name='discount_manual'`);
    hasManualCol = r.rows.length > 0;
  }
  return hasManualCol;
}

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
    // The discount of a line is the one the employee typed (limited to 0..MAX_DISCOUNT_PCT), or, when
    // nothing was typed, the one SAP gives this customer (customer_discounts). Typed ones are flagged.
    const { rows: custRows } = await client.query('SELECT card_code FROM customers WHERE id = $1', [customer_id]);
    const cardCode = custRows[0] ? custRows[0].card_code : null;
    const { rows: discRows } = await client.query(
      `SELECT i.id AS item_id, COALESCE(d.discount_pct, 0) AS pct
       FROM items i LEFT JOIN customer_discounts d ON d.item_code = i.item_code AND d.card_code = $1
       WHERE i.id = ANY($2::int[])`,
      [cardCode, items.map((i) => i.item_id)]
    );
    const pctByItem = new Map(discRows.map((r) => [r.item_id, Number(r.pct)]));
    const decide = (line) => {
      const sap = pctByItem.get(line.item_id) || 0;
      const typed = line.discount_pct;
      const has = typed !== undefined && typed !== null && typed !== '' && Number.isFinite(Number(typed));
      const pct = has ? Math.max(0, Math.min(MAX_DISCOUNT_PCT, Number(typed))) : sap;
      return { pct, manual: has && Math.abs(pct - sap) > 0.0001 };
    };
    const netOf = (line) => Number(line.quantity) * Number(line.unit_price) * (1 - decide(line).pct / 100);

    const total = items.reduce((sum, i) => sum + netOf(i), 0);
    const orderResult = await client.query(
      `INSERT INTO orders (client_uuid, user_id, customer_id, latitude, longitude, total_amount, order_date, created_offline)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [client_uuid, userId, customer_id, latitude, longitude, total, order_date, !!created_offline]
    );
    const orderId = orderResult.rows[0].id;
    const withFlag = await manualColumnExists(client);
    for (const line of items) {
      const d = decide(line);
      if (withFlag) {
        await client.query(
          `INSERT INTO order_items (order_id, item_id, quantity, unit_price, discount_pct, line_total, discount_manual)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [orderId, line.item_id, line.quantity, line.unit_price, d.pct, netOf(line), d.manual]
        );
      } else {
        await client.query(
          `INSERT INTO order_items (order_id, item_id, quantity, unit_price, discount_pct, line_total)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [orderId, line.item_id, line.quantity, line.unit_price, d.pct, netOf(line)]
        );
      }
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
    // Out of stock: a short, clear message instead of a SAP error. Orders created offline (sync-batch)
    // are accepted as they come; set BLOCK_ZERO_STOCK=off in .env to stop checking here too.
    if (String(process.env.BLOCK_ZERO_STOCK || 'on').toLowerCase() === 'on' && Array.isArray(req.body.items)) {
      const ids = req.body.items.map((i) => Number(i.item_id)).filter(Number.isFinite);
      // Stock is checked in the CUSTOMER's warehouse (customers.default_warehouse). No warehouse set on the
      // customer, or the per-warehouse table not present yet -> fall back to the item's default-warehouse stock.
      const { rows: cw } = await pool.query('SELECT default_warehouse FROM customers WHERE id = $1', [Number(req.body.customer_id)]);
      const whs = cw[0] && cw[0].default_warehouse && String(cw[0].default_warehouse).trim() !== '' ? String(cw[0].default_warehouse).trim() : null;
      let out;
      try {
        ({ rows: out } = await pool.query(
          `SELECT i.item_name FROM items i
           LEFT JOIN item_warehouse_stock s ON s.item_code = i.item_code AND s.whs_code = $2::text
           WHERE i.id = ANY($1::int[])
             AND COALESCE(CASE WHEN $2::text IS NULL THEN i.on_hand ELSE s.on_hand END, 0) <= 0`,
          [ids, whs]
        ));
      } catch (e) {
        if (e.code !== '42P01') throw e;
        ({ rows: out } = await pool.query('SELECT item_name FROM items WHERE id = ANY($1::int[]) AND COALESCE(on_hand,0) <= 0', [ids]));
      }
      if (out.length) {
        return res.status(409).json({ error: out.length === 1 ? `Out of stock: ${out[0].item_name}. Please refill.` : `Out of stock: ${out[0].item_name} and ${out.length - 1} more. Please refill.` });
      }
    }
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