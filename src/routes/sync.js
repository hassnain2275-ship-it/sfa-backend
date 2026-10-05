const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { pushPendingOrders, pullMasterData } = require('../services/sapService');

const router = express.Router();

// POST /api/v1/sync/orders -- force-push pending orders right now (great for demos)
router.post('/orders', requireAuth, async (req, res) => {
  try {
    const result = await pushPendingOrders();
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Manual order sync failed', detail: err.message });
  }
});

// POST /api/v1/sync/master-data -- force-pull customers/items from SAP right now
router.post('/master-data', requireAuth, async (req, res) => {
  try {
    const result = await pullMasterData();
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Manual master data sync failed', detail: err.message });
  }
});

module.exports = router;
