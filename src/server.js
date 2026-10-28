// Force this process to run in UTC regardless of the host OS's local timezone setting.
// This removes any ambiguity in how timestamps are parsed/stored -- without this, behavior
// can subtly depend on the machine's configured timezone, which caused the earlier bug.
process.env.TZ = 'UTC';

require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRouter = require('./routes/auth');
const attendanceRouter = require('./routes/attendance');
const masterDataRouter = require('./routes/masterdata');
const ordersRouter = require('./routes/orders');
const syncRouter = require('./routes/sync');
const expensesRouter = require('./routes/expenses');   // NEW
const trackingRouter = require('./routes/tracking');   // NEW
const reportsRouter = require('./routes/reports');     // NEW
const adminRouter = require('./routes/admin');         // NEW - web admin dashboard API
const dailyRouter = require('./routes/daily');         // NEW - captures, market photos, morning session, shops
const plansRouter = require('./routes/plans');         // NEW - employee plans, route grid, Plan vs Achieved
const { startSyncScheduler } = require('./services/syncScheduler');
const safeErrors = require('./middleware/safeErrors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(safeErrors); // 5xx bodies never reach the client with technical text
app.use('/uploads', express.static(require('path').join(__dirname, '..', 'uploads')));

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.use('/api/v1/auth', authRouter);
app.use('/api/v1/attendance', attendanceRouter);
app.use('/api/v1', masterDataRouter); // exposes /customers and /items
app.use('/api/v1/orders', ordersRouter);
app.use('/api/v1/sync', syncRouter);
app.use('/api/v1/expenses', expensesRouter);   // NEW
app.use('/api/v1/tracking', trackingRouter);   // NEW
app.use('/api/v1/reports', reportsRouter);     // NEW
app.use('/api/v1/admin', adminRouter);         // NEW
app.use('/api/v1', dailyRouter);               // NEW
app.use('/api/v1/plans', plansRouter);        // NEW
// Web admin dashboard (static page) - open  http://<server>/admin/
app.use('/admin', express.static(require('path').join(__dirname, '..', 'admin')));

// Unknown API route -> clean JSON instead of an HTML page
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
// Last-resort handler: log the real error here, send nothing technical to the client
app.use((err, req, res, next) => {
  console.error('[unhandled] ' + req.method + ' ' + req.originalUrl + ' -', err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  const status = err && err.status >= 400 && err.status < 500 ? err.status : 500;
  res.status(status).json({ error: status === 400 ? 'The request could not be read.' : 'Something went wrong.' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`SFA backend running on http://localhost:${PORT} (bound to all interfaces)`);
  startSyncScheduler(); // no-op until SAP_* env vars are filled in -- safe to leave running
});