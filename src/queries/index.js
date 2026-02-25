'use strict';
const pool = require('../db');
const eventStore = require('../eventStore');
const BankAccount = require('../domain/BankAccount');

// ----------------------------------------------------------------
// Query: GetAccount  (reads from account_summaries projection)
// ----------------------------------------------------------------
async function getAccount(accountId) {
    const result = await pool.query(
        `SELECT account_id, owner_name, balance, currency, status
       FROM account_summaries
      WHERE account_id = $1`,
        [accountId]
    );

    if (result.rows.length === 0) {
        const err = new Error('Account not found');
        err.status = 404;
        throw err;
    }

    const row = result.rows[0];
    return {
        accountId: row.account_id,
        ownerName: row.owner_name,
        balance: parseFloat(row.balance),
        currency: row.currency,
        status: row.status,
    };
}

// ----------------------------------------------------------------
// Query: GetEvents  (reads raw event stream for an aggregate)
// ----------------------------------------------------------------
async function getEvents(accountId) {
    const exists = await eventStore.aggregateExists(accountId);
    if (!exists) {
        const err = new Error('Account not found');
        err.status = 404;
        throw err;
    }

    const events = await eventStore.loadEvents(accountId, 0);

    return events.map((row) => ({
        eventId: row.event_id,
        eventType: row.event_type,
        eventNumber: row.event_number,
        data: row.event_data,
        timestamp: row.timestamp,
    }));
}

// ----------------------------------------------------------------
// Query: BalanceAt  (time-travel – replay events up to timestamp)
// ----------------------------------------------------------------
async function getBalanceAt(accountId, timestamp) {
    const exists = await eventStore.aggregateExists(accountId);
    if (!exists) {
        const err = new Error('Account not found');
        err.status = 404;
        throw err;
    }

    const events = await eventStore.loadEventsUpToTimestamp(accountId, timestamp);
    const account = BankAccount.fromEvents(events);

    return {
        accountId,
        balanceAt: account.balance,
        timestamp,
    };
}

// ----------------------------------------------------------------
// Query: GetTransactions  (paginated – reads from transaction_history)
// ----------------------------------------------------------------
async function getTransactions(accountId, page = 1, pageSize = 10) {
    // Check account exists via projection
    const accountCheck = await pool.query(
        `SELECT 1 FROM account_summaries WHERE account_id = $1`,
        [accountId]
    );
    if (accountCheck.rows.length === 0) {
        const err = new Error('Account not found');
        err.status = 404;
        throw err;
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const size = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 10));
    const offset = (pageNum - 1) * size;

    const countResult = await pool.query(
        `SELECT COUNT(*) AS total FROM transaction_history WHERE account_id = $1`,
        [accountId]
    );
    const totalCount = parseInt(countResult.rows[0].total, 10);
    const totalPages = Math.ceil(totalCount / size) || 1;

    const itemsResult = await pool.query(
        `SELECT transaction_id, type, amount, description, timestamp
       FROM transaction_history
      WHERE account_id = $1
      ORDER BY timestamp ASC
      LIMIT $2 OFFSET $3`,
        [accountId, size, offset]
    );

    return {
        currentPage: pageNum,
        pageSize: size,
        totalPages,
        totalCount,
        items: itemsResult.rows.map((row) => ({
            transactionId: row.transaction_id,
            type: row.type,
            amount: parseFloat(row.amount),
            description: row.description,
            timestamp: row.timestamp,
        })),
    };
}

module.exports = { getAccount, getEvents, getBalanceAt, getTransactions };
