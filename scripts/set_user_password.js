/*
 * Set (or reset) the app password of a user, for AUTH_MODE=synced.
 *
 *   cd backend
 *   node scripts/set_user_password.js <SAP user code or e-mail> <new password>
 *
 * The account must already exist (the SAP user sync creates it, every 5 minutes by default).
 * The password is stored as a bcrypt hash. It is never printed or logged.
 * Type it in YOUR OWN terminal; do not paste it into a chat.
 */
const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch (_) {}
const bcrypt = require('bcrypt');
const pool = require('../src/db');

(async () => {
  const who = String(process.argv[2] || '').trim();
  const pw = String(process.argv[3] || '');
  if (!who || !pw) {
    console.log('Usage: node scripts/set_user_password.js <SAP user code or e-mail> <new password>');
    process.exit(1);
  }
  if (pw.length < 6) {
    console.log('Password is too short: use at least 6 characters.');
    process.exit(1);
  }
  try {
    const { rows } = await pool.query(
      'SELECT id, name, sap_user_code, role, is_active FROM users WHERE LOWER(sap_user_code) = LOWER($1) OR LOWER(email) = LOWER($1) ORDER BY (LOWER(sap_user_code) = LOWER($1)) DESC LIMIT 1',
      [who]);
    if (!rows.length) {
      console.log('No account found for "' + who + '". If this is a new SAP user, wait for the next user sync (or restart the backend) and try again.');
      process.exit(2);
    }
    const u = rows[0];
    const hash = await bcrypt.hash(pw, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, u.id]);
    console.log('Password set for ' + (u.sap_user_code || who) + ' (' + u.name + ', role ' + u.role + ').');
    if (!u.is_active) console.log('WARNING: this account is NOT active. In SAP it is locked, or the SAP user has no Employee linked. It cannot log in until that is fixed.');
  } catch (e) {
    console.error('Could not set the password:', e.message);
    process.exit(3);
  } finally {
    await pool.end();
  }
})();