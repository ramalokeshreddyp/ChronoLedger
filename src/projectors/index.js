'use strict';
const pool = require('../db');
const eventStore = require('../eventStore');

/**
 * Projector – keeps the read models in sync with the event store.
 *
 * Supports:
 *  - project(eventRow)       : process a single event (called synchronously after each appendEvents)
 *  - rebuildAll()            : truncate projections and replay the full event history
 *  - getStatus()             : report lag between event store and projections
 */

// ----------------------------------------------------------------
// Per-event projection handlers
// ----------------------------------------------------------------

async function handleAccountCreated(data, client) {
    await client.query(
        `INSERT INTO account_summaries (account_id, owner_name, balance, currency, status, version)
     VALUES ($1, $2, $3, $4, 'OPEN', 1)
     ON CONFLICT (account_id) DO NOTHING`,
        [data.accountId, data.ownerName, parseFloat(data.initialBalance || 0), data.currency || 'USD']
    );
}

async function handleMoneyDeposited(data, eventRow, client) {
    await client.query(
        `UPDATE account_summaries
        SET balance = balance + $1,
            version = version + 1
      WHERE account_id = $2`,
        [parseFloat(data.amount), data.accountId]
    );

    await client.query(
        `INSERT INTO transaction_history (transaction_id, account_id, type, amount, description, timestamp)
     VALUES ($1, $2, 'DEPOSIT', $3, $4, $5)
     ON CONFLICT (transaction_id) DO NOTHING`,
        [
            data.transactionId || eventRow.event_id,
            data.accountId,
            parseFloat(data.amount),
            data.description || null,
            eventRow.timestamp,
        ]
    );
}

async function handleMoneyWithdrawn(data, eventRow, client) {
    await client.query(
        `UPDATE account_summaries
        SET balance = balance - $1,
            version = version + 1
      WHERE account_id = $2`,
        [parseFloat(data.amount), data.accountId]
    );

    await client.query(
        `INSERT INTO transaction_history (transaction_id, account_id, type, amount, description, timestamp)
     VALUES ($1, $2, 'WITHDRAWAL', $3, $4, $5)
     ON CONFLICT (transaction_id) DO NOTHING`,
        [
            data.transactionId || eventRow.event_id,
            data.accountId,
            parseFloat(data.amount),
            data.description || null,
            eventRow.timestamp,
        ]
    );
}

async function handleAccountClosed(data, client) {
    await client.query(
        `UPDATE account_summaries
        SET status  = 'CLOSED',
            version = version + 1
      WHERE account_id = $1`,
        [data.accountId]
    );
}

// ----------------------------------------------------------------
// Track global event position (using a simple counter column)
// We use the aggregate-level event_number; global ordering is done by timestamp + event_id.
// For checkpoint purposes we store a global sequence number as the rowcount of processed events.
// ----------------------------------------------------------------

async function updateCheckpoint(projectionName, globalEventSeq, client) {
    await client.query(
        `UPDATE projection_checkpoints
        SET last_processed_event_number = $1
      WHERE projection_name = $2`,
        [globalEventSeq, projectionName]
    );
}

// ----------------------------------------------------------------
// Public API
// ----------------------------------------------------------------

/**
 * Process a single newly committed event row and update the read models.
 * Called synchronously right after appendEvents so that projections are
 * eventually consistent with a near-zero lag.
 *
 * @param {object} eventRow  – Row from the events table
 * @param {number} globalSeq – The current global event count (for checkpoint)
 */
async function project(eventRow, globalSeq) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const data = eventRow.event_data;

        switch (eventRow.event_type) {
            case 'AccountCreated':
                await handleAccountCreated(data, client);
                break;
            case 'MoneyDeposited':
                await handleMoneyDeposited(data, eventRow, client);
                break;
            case 'MoneyWithdrawn':
                await handleMoneyWithdrawn(data, eventRow, client);
                break;
            case 'AccountClosed':
                await handleAccountClosed(data, client);
                break;
            default:
                break;
        }

        // Update both checkpoints with the new global count
        await updateCheckpoint('AccountSummaries', globalSeq, client);
        await updateCheckpoint('TransactionHistory', globalSeq, client);

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Full projection rebuild – wipe and replay from scratch.
 */
async function rebuildAll() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Truncate read models
        await client.query('TRUNCATE TABLE account_summaries');
        await client.query('TRUNCATE TABLE transaction_history');
        await client.query(`UPDATE projection_checkpoints SET last_processed_event_number = 0`);

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }

    // Replay all events in order
    const allEvents = await eventStore.getAllEvents();
    let seq = 0;
    for (const eventRow of allEvents) {
        seq++;
        await project(eventRow, seq);
    }
}

/**
 * Return lag/status of projections.
 */
async function getStatus() {
    const totalEvents = await eventStore.countEvents();

    const checkpointResult = await pool.query(
        `SELECT projection_name, last_processed_event_number FROM projection_checkpoints`
    );

    const projections = checkpointResult.rows.map((row) => ({
        name: row.projection_name,
        lastProcessedEventNumberGlobal: parseInt(row.last_processed_event_number, 10),
        lag: totalEvents - parseInt(row.last_processed_event_number, 10),
    }));

    return {
        totalEventsInStore: totalEvents,
        projections,
    };
}

module.exports = { project, rebuildAll, getStatus };
