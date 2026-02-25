'use strict';
const { Router } = require('express');
const commands = require('../commands');
const queries = require('../queries');

const router = Router();

// ----------------------------------------------------------------
// COMMAND endpoints (write side)
// ----------------------------------------------------------------

// POST /api/accounts  –  Create account
router.post('/', async (req, res, next) => {
    try {
        const { accountId, ownerName, initialBalance = 0, currency = 'USD' } = req.body;
        await commands.createAccount({ accountId, ownerName, initialBalance, currency });
        return res.status(202).json({ message: 'Account creation accepted', accountId });
    } catch (err) {
        next(err);
    }
});

// POST /api/accounts/:accountId/deposit
router.post('/:accountId/deposit', async (req, res, next) => {
    try {
        const { accountId } = req.params;
        const { amount, description, transactionId } = req.body;
        await commands.depositMoney(accountId, { amount, description, transactionId });
        return res.status(202).json({ message: 'Deposit accepted', accountId });
    } catch (err) {
        next(err);
    }
});

// POST /api/accounts/:accountId/withdraw
router.post('/:accountId/withdraw', async (req, res, next) => {
    try {
        const { accountId } = req.params;
        const { amount, description, transactionId } = req.body;
        await commands.withdrawMoney(accountId, { amount, description, transactionId });
        return res.status(202).json({ message: 'Withdrawal accepted', accountId });
    } catch (err) {
        next(err);
    }
});

// POST /api/accounts/:accountId/close
router.post('/:accountId/close', async (req, res, next) => {
    try {
        const { accountId } = req.params;
        const { reason } = req.body;
        await commands.closeAccount(accountId, { reason });
        return res.status(202).json({ message: 'Account close accepted', accountId });
    } catch (err) {
        next(err);
    }
});

// ----------------------------------------------------------------
// QUERY endpoints (read side)
// ----------------------------------------------------------------

// GET /api/accounts/:accountId  –  current state from projection
router.get('/:accountId', async (req, res, next) => {
    try {
        const account = await queries.getAccount(req.params.accountId);
        return res.status(200).json(account);
    } catch (err) {
        next(err);
    }
});

// GET /api/accounts/:accountId/events  –  raw event stream
router.get('/:accountId/events', async (req, res, next) => {
    try {
        const events = await queries.getEvents(req.params.accountId);
        return res.status(200).json(events);
    } catch (err) {
        next(err);
    }
});

// GET /api/accounts/:accountId/balance-at/:timestamp  –  time-travel
router.get('/:accountId/balance-at/:timestamp', async (req, res, next) => {
    try {
        const { accountId, timestamp } = req.params;
        const decoded = decodeURIComponent(timestamp);
        const result = await queries.getBalanceAt(accountId, decoded);
        return res.status(200).json(result);
    } catch (err) {
        next(err);
    }
});

// GET /api/accounts/:accountId/transactions  –  paginated history
router.get('/:accountId/transactions', async (req, res, next) => {
    try {
        const { accountId } = req.params;
        const { page = 1, pageSize = 10 } = req.query;
        const result = await queries.getTransactions(accountId, page, pageSize);
        return res.status(200).json(result);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
