// Background job runner -- direct replacement for old integrator timer.

const {
  pushPendingOrders,
  pushPendingTimeSheets,
  pullMasterData,
  pullUsers
} = require('./sapService');

let orderSyncRunning = false;
let timeSheetSyncRunning = false;
let masterDataSyncRunning = false;
let userSyncRunning = false;

function startSyncScheduler() {
  const orderInterval = Number(process.env.SAP_SYNC_INTERVAL_MS || 60000);
  const timeSheetInterval = Number(process.env.SAP_TIMESHEET_SYNC_INTERVAL_MS || 60000);
  const masterInterval = Number(process.env.MASTER_DATA_SYNC_INTERVAL_MS || 1800000);
  // How fast a lock / deactivation in SAP takes effect in the app.
  const userInterval = Number(process.env.USER_SYNC_INTERVAL_MS || 300000);

  // Orders
  setInterval(async () => {
    if (orderSyncRunning) return;

    orderSyncRunning = true;
    try {
      const result = await pushPendingOrders();

      if (result.total > 0) {
        console.log(
          `[order sync] ${result.successCount} synced, ${result.errorCount} failed`
        );
      }
    } catch (err) {
      console.error('[order sync] failed:', err.message);
    } finally {
      orderSyncRunning = false;
    }
  }, orderInterval);

  // SAP Timesheets
  setInterval(async () => {
    if (timeSheetSyncRunning) return;

    timeSheetSyncRunning = true;
    try {
      const result = await pushPendingTimeSheets();

      if (result.total > 0) {
        console.log(
          `[timesheet sync] ${result.successCount} synced, ${result.errorCount} failed`
        );
      }
    } catch (err) {
      console.error('[timesheet sync] failed:', err.message);
    } finally {
      timeSheetSyncRunning = false;
    }
  }, timeSheetInterval);

  // Master data
  setInterval(async () => {
    if (masterDataSyncRunning) return;

    masterDataSyncRunning = true;
    try {
      const result = await pullMasterData();

      console.log(
        `[master data sync] ${result.customers} customers, ${result.items} items`
      );
    } catch (err) {
      console.error('[master data sync] failed:', err.message);
    } finally {
      masterDataSyncRunning = false;
    }
  }, masterInterval);

  // SAP users -> app accounts (locks, employee changes, new hires)
  const runUserSync = async () => {
    if (userSyncRunning) return;
    userSyncRunning = true;
    try {
      const n = await pullUsers();
      console.log(`[user sync] ${n} SAP users synced`);
    } catch (err) {
      console.error('[user sync] failed:', err.message);
    } finally {
      userSyncRunning = false;
    }
  };
  // Only in SAP mode and synced mode: in local mode the users table is managed by hand and must
  // not be touched by a SAP sync.
  const schedMode = String(process.env.AUTH_MODE || 'local').toLowerCase();
  if (schedMode === 'sap' || schedMode === 'synced') {
    setInterval(runUserSync, userInterval);
    setTimeout(runUserSync, 10000); // once shortly after startup
  }

  console.log(
    `Sync scheduler started ` +
    `(orders every ${orderInterval / 1000}s, ` +
    `timesheets every ${timeSheetInterval / 1000}s, ` +
    `master data every ${masterInterval / 60000}min, ` +
    `users every ${userInterval / 60000}min)`
  );
}

module.exports = { startSyncScheduler };