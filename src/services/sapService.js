const axios = require('axios');
const pool = require('../db');

const { SAP_BRIDGE_URL, SAP_BRIDGE_API_KEY } = process.env;

if (!SAP_BRIDGE_API_KEY) {
  console.error(
    '[sapService] SAP_BRIDGE_API_KEY is not set - every call to the SAP bridge will be ' +
    'rejected with 401 until it is configured.'
  );
}

const bridge = axios.create({
  baseURL: SAP_BRIDGE_URL,
  timeout: 60000, // 60 seconds to allow for slow Render free tier wakeups
  headers: { 'X-API-Key': SAP_BRIDGE_API_KEY || '' },
});

bridge.interceptors.response.use(
  (response) => response,
  (err) => {
    const safe = new Error(err.message);
    safe.code = err.code;
    if (err.response) {
      safe.response = {
        status: err.response.status,
        statusText: err.response.statusText,
        data: err.response.data,
      };
    }
    return Promise.reject(safe);
  }
);

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
  const { rows: customer } = await pool.query('SELECT card_code, default_warehouse FROM customers WHERE id = $1', [order.customer_id]);
  const { rows: lines } = await pool.query(
    `SELECT oi.quantity, oi.unit_price, oi.discount_pct, i.item_code
     FROM order_items oi JOIN items i ON i.id = oi.item_id
     WHERE oi.order_id = $1`,
    [order.id]
  );
  const { rows: salesmen } = await pool.query(
    'SELECT name, sap_sales_employee_code FROM users WHERE id = $1',
    [order.user_id]
  );

  if (customer.length === 0) throw new Error(`No SAP CardCode mapped for customer_id ${order.customer_id}`);

  const whs = customer[0].default_warehouse && String(customer[0].default_warehouse).trim() !== ''
    ? String(customer[0].default_warehouse).trim() : null;

  const payload = {
    CardCode: customer[0].card_code,
    DocumentLines: lines.map((l) => ({
      ItemCode: l.item_code,
      Quantity: Number(l.quantity),
      UnitPrice: Number(l.unit_price),
      DiscountPercent: Number(l.discount_pct || 0),
      ...(whs ? { WarehouseCode: whs } : {}),
    })),
  };

  const salesmanCode = salesmen[0] && salesmen[0].sap_sales_employee_code;
  if (salesmanCode && String(salesmanCode).trim() !== '') {
    payload.SlpCode = Number(salesmanCode);
  } else {
    console.warn(
      `[sapService] Order user_id=${order.user_id} (${salesmen[0] ? salesmen[0].name : 'unknown user'}) has no ` +
      `sap_sales_employee_code set - this order will push to SAP WITHOUT a SlpCode.`
    );
  }

  return payload;
}

async function pullTimeSheetHistory(employeeId, from, to) {
  const res = await bridge.get('/timesheet', { params: { employeeId, from, to } });
  return res.data;
}

// ---------- PUSH TIME SHEETS ----------

const COMPANY_TZ = process.env.COMPANY_TZ || 'Asia/Karachi';

function localParts(d) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: COMPANY_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour === '24' ? '00' : p.hour}:${p.minute}` };
}

const NO_EMPLOYEE_MSG =
  'Waiting: this user has no sap_employee_id (SAP Employee ID, OHEM.empID) - set it on the user, then this time sheet is posted automatically';
let lastUnlinkedWarning = 0;
let timesheetPausedUntil = 0;

async function pushPendingTimeSheets() {
  if (String(process.env.SAP_TIMESHEET_SYNC || 'on').toLowerCase() !== 'on') {
    return { successCount: 0, errorCount: 0, total: 0, disabled: true };
  }
  if (Date.now() < timesheetPausedUntil) return { successCount: 0, errorCount: 0, total: 0, paused: true };
  
  const { rows: unlinked } = await pool.query(
    `SELECT u.name, COUNT(*)::int AS n FROM attendance a JOIN users u ON u.id = a.user_id
      WHERE a.check_out_at IS NOT NULL AND a.sap_synced = FALSE AND u.sap_employee_id IS NULL GROUP BY u.name`);
  if (unlinked.length > 0) {
    await pool.query(
      `UPDATE attendance a SET sap_sync_error = $1 FROM users u
        WHERE u.id = a.user_id AND a.check_out_at IS NOT NULL AND a.sap_synced = FALSE
          AND u.sap_employee_id IS NULL AND a.sap_sync_error IS DISTINCT FROM $1`, [NO_EMPLOYEE_MSG]);
    if (Date.now() - lastUnlinkedWarning > 30 * 60 * 1000) {
      lastUnlinkedWarning = Date.now();
      console.warn('[timesheet sync] waiting for a SAP employee link: ' +
        unlinked.map((u) => `${u.n} row(s) of "${u.name}"`).join(', '));
    }
  }

  const { rows: pending } = await pool.query(
    `SELECT a.*, u.sap_employee_id, u.name AS user_name
     FROM attendance a JOIN users u ON u.id = a.user_id
     WHERE a.check_out_at IS NOT NULL AND a.sap_synced = FALSE AND u.sap_employee_id IS NOT NULL
     ORDER BY a.marked_at ASC LIMIT 20`
  );

  let successCount = 0;
  let errorCount = 0;
  const failures = new Map();

  for (const record of pending) {
    try {
      if (!record.sap_employee_id) throw new Error(`User "${record.user_name}" has no sap_employee_id`);

      const start = localParts(new Date(record.marked_at));
      const end = localParts(new Date(record.check_out_at));
      const endTime = end.date === start.date ? end.time : '23:59';

      const payload = {
        EmployeeID: Number(record.sap_employee_id),
        Date: start.date,
        StartTime: start.time,
        EndTime: endTime,
        Remarks: `SFA mobile - ${Number(record.km_traveled || 0).toFixed(1)} km, ${record.orders_count} orders booked`,
      };

      await bridge.post('/timesheet', payload);

      await pool.query(`UPDATE attendance SET sap_synced = TRUE, sap_sync_error = NULL WHERE id = $1`, [record.id]);
      successCount++;
    } catch (err) {
      const message = err.response ? JSON.stringify(err.response.data) : err.message;
      await pool.query(`UPDATE attendance SET sap_sync_error = $1 WHERE id = $2`, [message, record.id]);
      errorCount++;
      if (!failures.has(message)) failures.set(message, []);
      failures.get(message).push(record.id);
    }
  }

  for (const [message, ids] of failures) {
    console.error(`[timesheet sync] ${ids.length} failed to post to SAP: ${message}`);
  }
  if (errorCount > 0 && successCount === 0) {
    timesheetPausedUntil = Date.now() + 5 * 60 * 1000;
    console.error('[timesheet sync] every attempt failed - pausing for 5 minutes.');
  } else if (successCount > 0) {
    timesheetPausedUntil = 0;
  }

  if (pending.length > 0) {
    await logSync('timesheet_up', errorCount === 0 ? 'success' : 'error', successCount, `${successCount} synced, ${errorCount} failed`);
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
      `INSERT INTO customers (card_code, card_name, address, default_warehouse, last_synced_at)
       VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (card_code) DO UPDATE
       SET card_name = EXCLUDED.card_name, address = EXCLUDED.address,
           default_warehouse = COALESCE(EXCLUDED.default_warehouse, customers.default_warehouse),
           last_synced_at = NOW()`,
      [c.CardCode, c.CardName, c.Address || null, (c.WhsCode && String(c.WhsCode).trim()) || null]
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
      `INSERT INTO items (item_code, item_name, price, on_hand, unit_weight, uom, last_synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT (item_code) DO UPDATE
       SET item_name = EXCLUDED.item_name,
           price = CASE WHEN EXCLUDED.price > 0 THEN EXCLUDED.price ELSE items.price END,
           on_hand = EXCLUDED.on_hand,
           unit_weight = EXCLUDED.unit_weight,
           uom = EXCLUDED.uom,
           last_synced_at = NOW()`,
      [item.ItemCode, item.ItemName, item.Price || 0, item.OnHand || 0, item.Weight || 0, item.UomCode || null]
    );
    count++;
  }
  await logSync('items_down', 'success', count, `${count} items synced`);
  return count;
}

async function pullStock() {
  const res = await bridge.get('/stock');
  const rows = res.data;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM item_warehouse_stock');
    if (rows.length > 0) {
      await client.query(
        `INSERT INTO item_warehouse_stock (item_code, whs_code, on_hand)
         SELECT * FROM unnest($1::text[], $2::text[], $3::numeric[])
         ON CONFLICT (item_code, whs_code) DO UPDATE SET on_hand = EXCLUDED.on_hand, last_synced_at = NOW()`,
        [rows.map((r) => r.ItemCode), rows.map((r) => r.WhsCode), rows.map((r) => r.OnHand)]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  await logSync('stock_down', 'success', rows.length, `${rows.length} warehouse stock rows synced`);
  return rows.length;
}

async function pullDiscounts() {
  const res = await bridge.get('/discounts');
  const rows = res.data;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM customer_discounts');
    if (rows.length > 0) {
      await client.query(
        `INSERT INTO customer_discounts (card_code, item_code, discount_pct)
         SELECT * FROM unnest($1::text[], $2::text[], $3::numeric[])
         ON CONFLICT (card_code, item_code) DO UPDATE SET discount_pct = EXCLUDED.discount_pct`,
        [rows.map((r) => r.CardCode), rows.map((r) => r.ItemCode), rows.map((r) => r.Discount)]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  await logSync('discounts_down', 'success', rows.length, `${rows.length} customer discounts synced`);
  return rows.length;
}

// ---------- SAP USERS (login accounts) ----------

async function upsertSapUser(u) {
  const code = String(u.UserCode || '').trim();
  if (!code) return null;

  const hasEmployee = Number(u.EmpID) > 0;
  const isSuper = u.SuperUser === 'Y';
  const active = u.Locked !== 'Y' && (hasEmployee ? u.EmpActive !== 'N' : isSuper);
  const derivedRole = isSuper ? 'admin' : (Number(u.ReportsCount) > 0 ? 'supervisor' : 'salesman');
  const fullName = `${u.FirstName || ''} ${u.LastName || ''}`.trim() || u.UserName || code;
  const slp = Number(u.SalesPrson) > 0 ? String(u.SalesPrson) : null;
  
  const empId = hasEmployee ? Number(u.EmpID) : null; 

  let { rows } = await pool.query('SELECT id FROM users WHERE sap_user_code = $1', [code]);
  if (rows.length === 0 && slp) {
    ({ rows } = await pool.query(
      'SELECT id FROM users WHERE sap_user_code IS NULL AND sap_sales_employee_code = $1 ORDER BY id LIMIT 1', [slp]));
  }

  if (rows.length > 0) {
    const { rows: out } = await pool.query(
      `UPDATE users SET
         sap_user_code = $1, sap_user_id = $2, sap_employee_id = COALESCE($3, sap_employee_id), name = $4,
         sap_sales_employee_code = COALESCE($5, sap_sales_employee_code),
         designation = $6, is_active = $7,
         role = COALESCE(role_override, $8), sap_synced_at = NOW()
       WHERE id = $9 RETURNING *`,
      [code, u.UserID, empId, fullName, slp, u.JobTitle || null, active, derivedRole, rows[0].id]
    );
    return out[0];
  }

  const emailBase = (u.Email && String(u.Email).trim()) || `${code.toLowerCase()}@sap.local`;
  const insert = (email) => pool.query(
    `INSERT INTO users (name, email, password_hash, role, sap_user_code, sap_user_id, sap_employee_id,
                        sap_sales_employee_code, designation, is_active, sap_synced_at)
     VALUES ($1,$2,'!sap-managed',$3,$4,$5,$6,$7,$8,$9,NOW()) RETURNING *`,
    [fullName, email, derivedRole, code, u.UserID, empId, slp, u.JobTitle || null, active]
  );
  try {
    return (await insert(emailBase)).rows[0];
  } catch (e) {
    if (e.code === '23505') return (await insert(`${code.toLowerCase()}@sap.local`)).rows[0];
    throw e;
  }
}

async function pullUsers() {
  const res = await bridge.get('/users');
  let count = 0;
  for (const u of res.data) {
    if (await upsertSapUser(u)) count++;
  }
  await logSync('users_down', 'success', count, `${count} SAP users synced`);
  return count;
}

async function pullMasterData() {
  try {
    const customers = await pullCustomers();
    const items = await pullItems();
    let discounts = 0;
    try {
      discounts = await pullDiscounts();
    } catch (e) {
      await logSync('discounts_down', 'error', 0, e.response ? JSON.stringify(e.response.data) : e.message);
    }
    let stock = 0;
    try {
      stock = await pullStock();
    } catch (e) {
      await logSync('stock_down', 'error', 0, e.response ? JSON.stringify(e.response.data) : e.message);
    }
    return { customers, items, discounts, stock };
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
  pullDiscounts,
  pullStock,
  pullUsers,
  upsertSapUser,
  bridge,
};