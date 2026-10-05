const axios = require('axios');
const pool = require('../db');

const { SAP_BRIDGE_URL } = process.env;
// Example: SAP_BRIDGE_URL=http://103.158.35.54:5050

const bridge = axios.create({
  baseURL: SAP_BRIDGE_URL,
  timeout: 20000,
});

async function logSync(sync_type, status, records_processed, message) {
  try {
    await pool.query(
      `INSERT INTO sync_log (sync_type, status, records_processed, message)
       VALUES ($1,$2,$3,$4)`,
      [sync_type, status, records_processed, message]
    );
  } catch (e) {
    console.error('Failed to write sync_log', e);
  }
}

async function buildSalesOrderPayload(order) {
  const { rows: customer } = await pool.query('SELECT card_code FROM customers WHERE id = $1', [order.customer_id]);
  const { rows: lines } = await pool.query(
    `SELECT oi.quantity, oi.unit_price, i.item_code
     FROM order_items oi JOIN items i ON i.id = oi.item_id
     WHERE oi.order_id = $1`,
    [order.id]
  );
  const { rows: salesmen } = await pool.query(
    'SELECT name, sap_sales_employee_code FROM users WHERE id = $1',
    [order.user_id]
  );

  if (customer.length === 0) throw new Error(`No SAP CardCode mapped for customer_id ${order.customer_id}`);

  const payload = {
    CardCode: customer[0].card_code,
    DocumentLines: lines.map((l) => ({
      ItemCode: l.item_code,
      Quantity: Number(l.quantity),
      UnitPrice: Number(l.unit_price),
    })),
  };

  // Tag the order with a real, structured SAP Sales Employee code (SlpCode)
  // so it's queryable by employee directly in SAP - not just a free-text
  // note. Without this, a live "pull orders by employee" against SAP is not
  // possible at all, only our own Postgres copy (which already has user_id).
  const salesmanCode = salesmen[0] && salesmen[0].sap_sales_employee_code;
  if (salesmanCode && String(salesmanCode).trim() !== '') {
    payload.SlpCode = Number(salesmanCode);
  } else {
    // Don't block the order over a missing mapping - still push it, just make
    // the gap loud and visible so it gets fixed rather than silently losing
    // the ability to ever query this specific order by salesman in SAP.
    console.warn(
      `[sapService] Order user_id=${order.user_id} (${salesmen[0] ? salesmen[0].name : 'unknown user'}) has no ` +
      `sap_sales_employee_code set - this order will push to SAP WITHOUT a SlpCode. ` +
      `Set users.sap_sales_employee_code to the correct SAP Sales Employee code (OSLP.SlpCode) to fix.`
    );
  }

  return payload;
}

async function pullTimeSheetHistory(employeeId, from, to) {
  const res = await bridge.get('/timesheet', { params: { employeeId, from, to } });
  return res.data; // array of { EmployeeID, Date, StartTime, EndTime, Remarks }
}

// ---------- PUSH TIME SHEETS ----------

async function pushPendingTimeSheets() {
  const { rows: pending } = await pool.query(
    `SELECT a.*, u.sap_employee_id, u.name AS user_name
     FROM attendance a JOIN users u ON u.id = a.user_id
     WHERE a.check_out_at IS NOT NULL AND a.sap_synced = FALSE
     ORDER BY a.marked_at ASC LIMIT 20`
  );

  let successCount = 0;
  let errorCount = 0;

  for (const record of pending) {
    try {
      if (!record.sap_employee_id) {
        throw new Error(
          `User "${record.user_name}" has no sap_employee_id set - ` +
          `set this from SAP's Human Resources > Employee Master Data screen`
        );
      }

      const startTime = new Date(record.marked_at);
      const endTime = new Date(record.check_out_at);

      const payload = {
        EmployeeID: record.sap_employee_id,
        Date: startTime.toISOString().split('T')[0],
        StartTime: startTime.toTimeString().slice(0, 5), // "HH:MM"
        EndTime: endTime.toTimeString().slice(0, 5),
        Remarks: `SFA mobile - ${Number(record.km_traveled || 0).toFixed(1)} km, ${record.orders_count} orders booked`,
      };

      const res = await bridge.post('/timesheet', payload);
      const docEntry = res.data.DocEntry;

      await pool.query(
        `UPDATE attendance SET sap_synced = TRUE, sap_sync_error = NULL WHERE id = $1`,
        [record.id]
      );
      successCount++;
    } catch (err) {
      const message = err.response ? JSON.stringify(err.response.data) : err.message;
      await pool.query(
        `UPDATE attendance SET sap_sync_error = $1 WHERE id = $2`,
        [message, record.id]
      );
      errorCount++;
      console.error(`Time Sheet for attendance ${record.id} failed to sync to SAP:`, message);
    }
  }

  if (pending.length > 0) {
    await logSync('timesheet_up', errorCount === 0 ? 'success' : 'error', successCount,
      `${successCount} synced, ${errorCount} failed`);
  }
  return { successCount, errorCount, total: pending.length };
}

// ---------- PUSH ORDERS ----------

async function pushPendingOrders() {
  const { rows: pending } = await pool.query(
    `SELECT * FROM orders WHERE sync_status = 'pending' ORDER BY order_date ASC LIMIT 20`
  );

  let successCount = 0;
  let errorCount = 0;

  for (const order of pending) {
    try {
      const payload = await buildSalesOrderPayload(order);
      const res = await bridge.post('/orders', payload);
      const docEntry = res.data.DocEntry;

      await pool.query(
        `UPDATE orders SET sync_status='synced', sap_doc_entry=$1, synced_at=NOW(), sync_error=NULL,
                sfa_order_no=$3
         WHERE id=$2`,
        [docEntry, order.id, res.data.SfaOrderNo || null]
      );
      successCount++;
    } catch (err) {
      const message = err.response ? JSON.stringify(err.response.data) : err.message;
      await pool.query(
        `UPDATE orders SET sync_status='error', sync_error=$1 WHERE id=$2`,
        [message, order.id]
      );
      errorCount++;
      console.error(`Order ${order.client_uuid} failed to sync to SAP:`, message);
    }
  }

  if (pending.length > 0) {
    await logSync('order_up', errorCount === 0 ? 'success' : 'error', successCount,
      `${successCount} synced, ${errorCount} failed`);
  }
  return { successCount, errorCount, total: pending.length };
}

// ---------- PULL MASTER DATA ----------

async function pullCustomers() {
  const res = await bridge.get('/customers');
  const customers = res.data;

  let count = 0;
  for (const c of customers) {
    await pool.query(
      `INSERT INTO customers (card_code, card_name, address, last_synced_at)
       VALUES ($1,$2,$3,NOW())
       ON CONFLICT (card_code) DO UPDATE
       SET card_name = EXCLUDED.card_name, address = EXCLUDED.address, last_synced_at = NOW()`,
      [c.CardCode, c.CardName, c.Address || null]
    );
    count++;
  }
  await logSync('customers_down', 'success', count, `${count} customers synced`);
  return count;
}

async function pullItems() {
  const res = await bridge.get('/items');
  const items = res.data;

  let count = 0;
  for (const item of items) {
    await pool.query(
      `INSERT INTO items (item_code, item_name, price, last_synced_at)
       VALUES ($1,$2,$3,NOW())
       ON CONFLICT (item_code) DO UPDATE
       SET item_name = EXCLUDED.item_name,
           price = CASE WHEN EXCLUDED.price > 0 THEN EXCLUDED.price ELSE items.price END,
           last_synced_at = NOW()`,
      [item.ItemCode, item.ItemName, item.Price || 0]
    );
    count++;
  }
  await logSync('items_down', 'success', count, `${count} items synced`);
  return count;
}

async function pullMasterData() {
  try {
    const customers = await pullCustomers();
    const items = await pullItems();
    return { customers, items };
  } catch (err) {
    const message = err.response ? JSON.stringify(err.response.data) : err.message;
    await logSync('master_data_down', 'error', 0, message);
    throw err;
  }
}

module.exports = {
  pushPendingOrders,
  pushPendingTimeSheets,
  pullTimeSheetHistory,
  pullMasterData,
  pullCustomers,
  pullItems,
};