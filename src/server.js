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
const { startSyncScheduler } = require('./services/syncScheduler');

const app = express();
app.use(cors());
app.use(express.json());
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

const PORT = process.env.PORT || 4000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`SFA backend running on http://localhost:${PORT} (bound to all interfaces)`);
  startSyncScheduler(); // no-op until SAP_* env vars are filled in -- safe to leave running
});