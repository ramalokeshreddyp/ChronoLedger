'use strict';
const { Router } = require('express');
const projector = require('../projectors');

const router = Router();

// POST /api/projections/rebuild
router.post('/rebuild', async (req, res, next) => {
    try {
        // Fire-and-forget in the background so we return 202 immediately
        projector.rebuildAll().catch((err) => {
            console.error('Projection rebuild error:', err);
        });
        return res.status(202).json({ message: 'Projection rebuild initiated.' });
    } catch (err) {
        next(err);
    }
});

// GET /api/projections/status
router.get('/status', async (req, res, next) => {
    try {
        const status = await projector.getStatus();
        return res.status(200).json(status);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
