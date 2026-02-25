'use strict';
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');

const accountsRouter = require('./routes/accounts');
const projectionsRouter = require('./routes/projections');

const app = express();

// Middleware
app.use(helmet());
app.use(cors());
app.use(morgan('combined'));
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API routes
app.use('/api/accounts', accountsRouter);
app.use('/api/projections', projectionsRouter);

// 404 fallback
app.use((req, res) => {
    res.status(404).json({ error: 'Not Found', path: req.path });
});

// Global error handler
app.use((err, req, res, _next) => {
    const status = err.status || 500;
    const body = {
        error: err.message || 'Internal Server Error',
    };
    if (err.code) body.code = err.code;
    if (status === 500) {
        console.error('Unhandled error:', err);
    }
    res.status(status).json(body);
});

module.exports = app;
