const jwt = require('jsonwebtoken');
const pool = require('../db');

// Every request re-checks the user's CURRENT status in our database (which is
// kept in step with SAP by the user sync). A token alone is not enough: the
// moment an employee is locked / deactivated in SAP and the next sync runs,
// every request they make is refused - even with a still-valid token.
const CACHE_MS = 30 * 1000;
const cache = new Map(); // userId -> { at, row }

function invalidateUserCache(userId) {
  if (userId == null) cache.clear();
  else cache.delete(userId);
}

async function loadUser(id) {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.row;
  const { rows } = await pool.query(
    'SELECT id, email, role, is_active FROM users WHERE id = $1', [id]);
  const row = rows[0] || null;
  cache.set(id, { at: Date.now(), row });
  return row;
}

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing token' });

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch (e) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // AUTH_MODE=local (default): original behaviour - a valid token is enough.
    // The live is-the-account-still-active check applies in SAP mode and in synced mode.
    const authMode = String(process.env.AUTH_MODE || 'local').toLowerCase();
    if (authMode !== 'sap' && authMode !== 'synced') {
      req.user = { id: payload.id, email: payload.email, role: payload.role };
      return next();
    }

    const user = await loadUser(payload.id);
    if (!user || !user.is_active) {
      return res.status(403).json({
        error: 'Your account has been disabled. Contact your administrator.',
        code: 'ACCOUNT_DISABLED',
      });
    }

    // role comes from the database, so a role change applies immediately
    req.user = { id: user.id, email: user.email, role: user.role };
    next();
  } catch (err) {
    console.error('Auth middleware error:', err);
    res.status(500).json({ error: 'Auth check failed' });
  }
}

// usage: router.get('/x', requireAuth, requireRole('admin', 'supervisor'), handler)
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission to do this' });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole, invalidateUserCache };