const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const attendanceReport = require('../services/attendanceReport');
const ordersReport = require('../services/ordersReport');
const expenseReport = require('../services/expenseReport');

const router = express.Router();

router.get('/summary', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    const attendance = await pool.query(
      `SELECT a.id, a.status, a.marked_at, a.latitude, a.longitude, c.card_name
       FROM attendance a LEFT JOIN customers c ON c.id = a.customer_id
       WHERE a.user_id = $1 ORDER BY a.marked_at DESC LIMIT 30`,
      [userId]
    );

    const expenses = await pool.query(
      `SELECT id, expense_type, from_latitude, from_longitude, to_latitude, to_longitude, km, rate_per_km, amount, expense_date 
       FROM expenses
       WHERE user_id = $1 ORDER BY expense_date DESC LIMIT 30`,
      [userId]
    );

    const ordersResult = await pool.query(
      `SELECT o.id, o.total_amount, o.sync_status, o.order_date, c.card_name, o.client_uuid
       FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
       WHERE o.user_id = $1 ORDER BY o.order_date DESC LIMIT 30`,
      [userId]
    );

    // Get order items (using order_items table)
    const orders = [];
    for (const order of ordersResult.rows) {
      try {
        const linesResult = await pool.query(
          `SELECT 
             oi.id,
             oi.quantity,
             oi.unit_price,
             oi.line_total,
             COALESCE(i.item_name, 'Unknown Product') AS item_name,
             i.item_code
           FROM order_items oi
           LEFT JOIN items i ON oi.item_id = i.id
           WHERE oi.order_id = $1`,
          [order.id]
        );

        orders.push({
          id: order.id,
          card_name: order.card_name || 'Unknown Customer',
          total_amount: parseFloat(order.total_amount) || 0,
          sync_status: order.sync_status,
          order_date: order.order_date,
          client_uuid: order.client_uuid,
          lines: linesResult.rows.map(line => ({
            item_name: line.item_name || 'Unknown Product',
            item_code: line.item_code || '',
            quantity: parseFloat(line.quantity) || 0,
            unit_price: parseFloat(line.unit_price) || 0,
            line_total: parseFloat(line.line_total) || 0
          }))
        });
      } catch (lineErr) {
        console.warn(`Could not fetch lines for order ${order.id}:`, lineErr.message);
        orders.push({
          id: order.id,
          card_name: order.card_name || 'Unknown Customer',
          total_amount: parseFloat(order.total_amount) || 0,
          sync_status: order.sync_status,
          order_date: order.order_date,
          client_uuid: order.client_uuid,
          lines: []
        });
      }
    }

    const totals = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM attendance WHERE user_id = $1 AND status = 'present') AS days_present,
         (SELECT COALESCE(SUM(amount),0) FROM expenses WHERE user_id = $1) AS total_expenses,
         (SELECT COUNT(*) FROM orders WHERE user_id = $1) AS total_orders,
         (SELECT COALESCE(SUM(total_amount),0) FROM orders WHERE user_id = $1) AS total_order_value`,
      [userId]
    );

    res.json({
      totals: totals.rows[0],
      attendance: attendance.rows,
      expenses: expenses.rows,
      orders: orders,
    });
  } catch (err) {
    console.error('Reports error:', err);
    res.status(500).json({ error: 'Failed to load reports' });
  }
});

// ---------------------------------------------------------------------
// Crystal Reports tab - three report types, all built and formatted by us
// (not the actual SAP Crystal Reports engine - see chat notes), all sharing
// the same three parameters the client described: From Date, To Date,
// Employee ID. Employee ID always defaults to the logged-in user - the
// mobile app has no reason to ever request a different one. Every report
// supports both format=pdf and format=xlsx.
// ---------------------------------------------------------------------

function sendReport(res, buffer, format, filenameBase) {
  if (format === 'xlsx') {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.xlsx"`);
  } else {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.pdf"`);
  }
  res.send(buffer);
}

function parseFromTo(req, res) {
  const { from, to } = req.query;
  const format = (req.query.format || 'pdf').toLowerCase();
  if (!from || !to) {
    res.status(400).json({ error: 'from and to query parameters are required' });
    return null;
  }
  if (!['pdf', 'xlsx'].includes(format)) {
    res.status(400).json({ error: "format must be 'pdf' or 'xlsx'" });
    return null;
  }
  return { from, to, format };
}

// GET /reports/attendance-report?from=&to=&format=pdf|xlsx
router.get('/attendance-report', requireAuth, async (req, res) => {
  try {
    const parsed = parseFromTo(req, res);
    if (!parsed) return;
    const { from, to, format } = parsed;

    const data = await attendanceReport.fetchAttendanceReportData(pool, req.user.id, from, to);
    if (!data) return res.status(404).json({ error: 'Employee not found' });

    const buffer = format === 'xlsx' ? await attendanceReport.buildXlsx(data) : await attendanceReport.buildPdf(data);
    sendReport(res, buffer, format, `attendance_report_${from}_to_${to}`);
  } catch (err) {
    console.error('Attendance report generation failed:', err);
    res.status(500).json({ error: err.message || 'Attendance report generation failed' });
  }
});

// GET /reports/orders-report?from=&to=&format=pdf|xlsx
router.get('/orders-report', requireAuth, async (req, res) => {
  try {
    const parsed = parseFromTo(req, res);
    if (!parsed) return;
    const { from, to, format } = parsed;

    const data = await ordersReport.fetchOrdersReportData(pool, req.user.id, from, to);
    if (!data) return res.status(404).json({ error: 'Employee not found' });

    const buffer = format === 'xlsx' ? await ordersReport.buildXlsx(data) : await ordersReport.buildPdf(data);
    sendReport(res, buffer, format, `orders_report_${from}_to_${to}`);
  } catch (err) {
    console.error('Orders report generation failed:', err);
    res.status(500).json({ error: err.message || 'Orders report generation failed' });
  }
});

// GET /reports/expense-report?from=&to=&format=pdf|xlsx
router.get('/expense-report', requireAuth, async (req, res) => {
  try {
    const parsed = parseFromTo(req, res);
    if (!parsed) return;
    const { from, to, format } = parsed;

    const data = await expenseReport.fetchReportData(pool, req.user.id, from, to);
    if (!data) return res.status(404).json({ error: 'Employee not found' });

    const buffer = format === 'xlsx' ? await expenseReport.buildXlsx(data) : await expenseReport.buildPdf(data);
    sendReport(res, buffer, format, `expense_report_${from}_to_${to}`);
  } catch (err) {
    console.error('Expense report generation failed:', err);
    res.status(500).json({ error: err.message || 'Expense report generation failed' });
  }
});

module.exports = router;