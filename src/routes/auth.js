const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { bridge, upsertSapUser } = require('../services/sapService');
const { invalidateUserCache } = require('../middleware/auth');

const router = express.Router();

// AUTH_MODE (backend env var):
//   local (DEFAULT) - the original login: e-mail + password stored in our own users table.
//   sap             - login is verified against SAP (see sapLogin below).
// Switching is just changing this variable and restarting Node - no code change.
const isSapMode = () => String(process.env.AUTH_MODE || 'local').toLowerCase() === 'sap';

// When the SAP bridge is unreachable (server off, ngrok down), allow people who
// have logged in successfully before to get back in with the same password.
// This is ONLY used when the bridge cannot be reached - if SAP answers "wrong
// password" or "locked", that answer is final. A user locked in SAP while the
// bridge is down is cut off at the next user sync after it comes back.
// Set ALLOW_CACHED_LOGIN=false in .env to turn this off completely.
const ALLOW_CACHED_LOGIN = String(process.env.ALLOW_CACHED_LOGIN || 'true').toLowerCase() !== 'false';


// ---- wrong-password limiter (protects real SAP accounts from being locked by repeated guesses)
// 5 wrong attempts for the same user from the same address -> blocked for 10 minutes.
const FAIL_MAX = 5;
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const failures = new Map(); // key -> { count, first }
const failKey = (req, name) => String(req.ip || '') + '|' + String(name || '').toLowerCase();
function blockedForMs(key) {
  const f = failures.get(key);
  if (!f) return 0;
  if (Date.now() - f.first > FAIL_WINDOW_MS) { failures.delete(key); return 0; }
  return f.count >= FAIL_MAX ? FAIL_WINDOW_MS - (Date.now() - f.first) : 0;
}
function recordFailure(key) {
  const f = failures.get(key);
  if (!f || Date.now() - f.first > FAIL_WINDOW_MS) failures.set(key, { count: 1, first: Date.now() });
  else f.count += 1;
}
const clearFailures = (key) => failures.delete(key);
const tooMany = (res, ms) => res.status(429).json({ error: 'Too many wrong attempts. Please wait ' + Math.max(1, Math.ceil(ms / 60000)) + ' minute(s) and try again.' });

function issueToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '3d' }
  );
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    sap_user_code: user.sap_user_code,
    designation: user.designation,
  };
}

// POST /api/v1/auth/login   body: { username, password }   (username = SAP user code)
// There is NO app-side registration any more: accounts come from SAP.
async function sapLogin(req, res) {
  try {
    const username = String(req.body.username || req.body.email || '').trim();
    const password = String(req.body.password || '');
    if (!username || !password) {
      return res.status(400).json({ error: 'SAP user code and password are required' });
    }
    const lk = failKey(req, username);
    const waitMs = blockedForMs(lk);
    if (waitMs) return tooMany(res, waitMs);

    let sapInfo = null;
    try {
      const r = await bridge.post('/auth/verify', { userCode: username, password }, { timeout: 30000 });
      sapInfo = r.data;
    } catch (err) {
      if (err.response && err.response.status === 401) {
        recordFailure(lk);
        return res.status(401).json({ error: (err.response.data && err.response.data.error) || 'Invalid SAP user code or password' });
      }
      if (err.response) {
        // bridge answered but with an error (e.g. 500) - not a reason to guess
        console.error('SAP login check failed:', err.response.status, JSON.stringify(err.response.data));
        return res.status(502).json({ error: 'SAP could not verify the login right now. Try again shortly.' });
      }
      // bridge unreachable -> cached fallback
      if (ALLOW_CACHED_LOGIN) {
        const { rows } = await pool.query('SELECT * FROM users WHERE LOWER(sap_user_code) = LOWER($1)', [username]);
        const cached = rows[0];
        if (cached && cached.is_active && cached.password_hash !== '!sap-managed' &&
            await bcrypt.compare(password, cached.password_hash)) {
          await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [cached.id]);
          return res.json({ token: issueToken(cached), user: publicUser(cached), offline_login: true });
        }
      }
      console.error('SAP bridge unreachable during login:', err.message);
      return res.status(503).json({ error: 'Cannot reach SAP right now. Check your connection and try again.' });
    }

    const user = await upsertSapUser(sapInfo);
    if (!user) return res.status(401).json({ error: 'Invalid SAP user code or password' });
    invalidateUserCache(user.id);
    clearFailures(lk);

    if (!user.is_active) {
      return res.status(403).json({
        error: 'Your account is not active for the SFA app. Contact your administrator.',
        code: 'ACCOUNT_DISABLED',
      });
    }

    // Remember a hash of the SAP-verified password (only used for the bridge-down fallback).
    const hash = await bcrypt.hash(password, 10);
    await pool.query('UPDATE users SET password_hash = $1, last_login_at = NOW() WHERE id = $2', [hash, user.id]);

    res.json({ token: issueToken(user), user: publicUser(user) });
  } catch (err) {
    console.error('Login failed:', err);
    res.status(500).json({ error: 'Login failed' });
  }
}

// ---------- ORIGINAL LOGIN (AUTH_MODE=local) - behaviour unchanged ----------
async function localLogin(req, res) {
  try {
    // the app sends the typed text as both `email` and `username`
    const email = String(req.body.email || req.body.username || '').trim();
    const password = req.body.password;
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' } // long-lived: salesmen shouldn't have to re-login constantly in the field
    );

    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
}


// ---------- WEB DASHBOARD LOGIN ----------
// Always the local e-mail + password, whatever AUTH_MODE is. SAP login is for the mobile app only.
// Only admin and supervisor accounts can use it.
async function adminLogin(req, res) {
  try {
    const email = String(req.body.email || req.body.username || '').trim();
    const password = String(req.body.password || '');
    if (!email || !password) return res.status(400).json({ error: 'Enter your email and password.' });
    const key = failKey(req, 'dash:' + email);
    const waitMs = blockedForMs(key);
    if (waitMs) return tooMany(res, waitMs);

    const { rows } = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1) OR LOWER(sap_user_code) = LOWER($1) ORDER BY (LOWER(email) = LOWER($1)) DESC LIMIT 1', [email]);
    const user = rows[0];
    const good = !!user && user.is_active !== false && ['admin', 'supervisor'].includes(user.role) &&
      !!user.password_hash && user.password_hash !== '!sap-managed' && await bcrypt.compare(password, user.password_hash);
    if (!good) { recordFailure(key); return res.status(401).json({ error: 'Invalid email or password.' }); }
    clearFailures(key);
    try { await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]); } catch (_) { /* column optional */ }
    res.json({ token: issueToken(user), user: publicUser(user) });
  } catch (err) {
    console.error('Dashboard login failed:', err);
    res.status(500).json({ error: 'Login failed' });
  }
}
router.post('/admin-login', adminLogin);

router.post('/login', (req, res) => (isSapMode() ? sapLogin(req, res) : localLogin(req, res)));

// POST /api/v1/auth/register - ORIGINAL behaviour, available only in local mode.
// (In SAP mode accounts come from SAP, so registration is closed.)
router.post('/register', async (req, res) => {
  if (isSapMode()) {
    return res.status(404).json({ error: 'Registration is disabled - accounts come from SAP' });
  }
  try {
    // `role` from the request is deliberately IGNORED: self-registration always makes a plain salesman.
    // (Otherwise anyone who can reach the server could register themselves as admin.)
    const { name, email, password } = req.body;
    const role = null;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'name, email, password are required' });
    }
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ($1, $2, $3, COALESCE($4, 'salesman'))
       RETURNING id, name, email, role`,
      [name, email, hash, role]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Email already registered' });
    }
    console.error(err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

module.exports = router;