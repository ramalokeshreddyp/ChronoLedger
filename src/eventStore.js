'use strict';
const { v4: uuidv4 } = require('uuid');
const pool = require('./db');

/**
 * EventStore – the core of the Event Sourcing write model.
 *
 * Responsibilities:
 *  - Append events with optimistic concurrency (unique constraint on aggregate_id + event_number)
 *  - Load events for an aggregate (optionally from a given event number)
 *  - Load / save snapshots
 *  - Load all events globally (for projection rebuild)
 */
class EventStore {
    /**
     * Append one or more events to the store for a given aggregate.
     *
     * @param {string}   aggregateId      - The ID of the aggregate (e.g. accountId)
     * @param {string}   aggregateType    - e.g. 'BankAccount'
     * @param {number}   expectedVersion  - The last known event_number. Used for optimistic concurrency.
     * @param {object[]} newEvents        - Array of { eventType, eventData, version? }
     * @param {object}   [client]         - Optional pg client (for transactions)
     * @returns {object[]} The persisted event rows
     */
    async appendEvents(aggregateId, aggregateType, expectedVersion, newEvents, client) {
        const db = client || pool;
        const persisted = [];

        for (let i = 0; i < newEvents.length; i++) {
            const { eventType, eventData, version = 1 } = newEvents[i];
            const eventNumber = expectedVersion + i + 1;
            const eventId = uuidv4();
            const timestamp = new Date().toISOString();

            try {
                const result = await db.query(
                    `INSERT INTO events
             (event_id, aggregate_id, aggregate_type, event_type, event_data, event_number, timestamp, version)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
           RETURNING *`,
                    [eventId, aggregateId, aggregateType, eventType, JSON.stringify(eventData), eventNumber, timestamp, version]
                );
                persisted.push(result.rows[0]);
            } catch (err) {
                if (err.code === '23505') {
                    // Unique violation on (aggregate_id, event_number) → concurrency conflict
                    const conflictErr = new Error(
                        `Concurrency conflict: event_number ${eventNumber} already exists for aggregate ${aggregateId}`
                    );
                    conflictErr.status = 409;
                    conflictErr.code = 'CONCURRENCY_CONFLICT';
                    throw conflictErr;
                }
                throw err;
            }
        }

        return persisted;
    }

    /**
     * Load all events for an aggregate, optionally starting from a given event_number.
     * @param {string} aggregateId
     * @param {number} [fromEventNumber=0] - Load events AFTER this number (exclusive)
     */
    async loadEvents(aggregateId, fromEventNumber = 0) {
        const result = await pool.query(
            `SELECT * FROM events
        WHERE aggregate_id = $1
          AND event_number > $2
        ORDER BY event_number ASC`,
            [aggregateId, fromEventNumber]
        );
        return result.rows;
    }

    /**
     * Check whether any events exist for an aggregate (i.e. does it exist?).
     */
    async aggregateExists(aggregateId) {
        const result = await pool.query(
            `SELECT 1 FROM events WHERE aggregate_id = $1 LIMIT 1`,
            [aggregateId]
        );
        return result.rows.length > 0;
    }

    /**
     * Get the latest event_number for an aggregate (0 if none).
     */
    async getLatestEventNumber(aggregateId) {
        const result = await pool.query(
            `SELECT COALESCE(MAX(event_number), 0) AS max_event_number FROM events WHERE aggregate_id = $1`,
            [aggregateId]
        );
        return parseInt(result.rows[0].max_event_number, 10);
    }

    /**
     * Load the latest snapshot for an aggregate. Returns null if none.
     */
    async loadSnapshot(aggregateId) {
        const result = await pool.query(
            `SELECT * FROM snapshots WHERE aggregate_id = $1`,
            [aggregateId]
        );
        return result.rows[0] || null;
    }

    /**
     * Create or replace the snapshot for an aggregate.
     */
    async saveSnapshot(aggregateId, snapshotData, lastEventNumber) {
        const snapshotId = uuidv4();
        await pool.query(
            `INSERT INTO snapshots (snapshot_id, aggregate_id, snapshot_data, last_event_number, created_at)
       VALUES ($1, $2, $3::jsonb, $4, NOW())
       ON CONFLICT (aggregate_id) DO UPDATE
         SET snapshot_id       = EXCLUDED.snapshot_id,
             snapshot_data     = EXCLUDED.snapshot_data,
             last_event_number = EXCLUDED.last_event_number,
             created_at        = EXCLUDED.created_at`,
            [snapshotId, aggregateId, JSON.stringify(snapshotData), lastEventNumber]
        );
    }

    /**
     * Load ALL events globally, optionally after a given global position.
     * "Global" order is by event_id insertion ordering via timestamp + event_id as tiebreaker.
     */
    async getAllEvents(afterTimestamp = null) {
        if (afterTimestamp) {
            const result = await pool.query(
                `SELECT * FROM events WHERE timestamp > $1 ORDER BY timestamp ASC, event_id ASC`,
                [afterTimestamp]
            );
            return result.rows;
        }
        const result = await pool.query(
            `SELECT * FROM events ORDER BY timestamp ASC, event_id ASC`
        );
        return result.rows;
    }

    /**
     * Count total events in store.
     */
    async countEvents() {
        const result = await pool.query(`SELECT COUNT(*) AS total FROM events`);
        return parseInt(result.rows[0].total, 10);
    }

    /**
     * Load events up to and including a given timestamp (for time-travel queries).
     */
    async loadEventsUpToTimestamp(aggregateId, timestamp) {
        const result = await pool.query(
            `SELECT * FROM events
        WHERE aggregate_id = $1
          AND timestamp <= $2
        ORDER BY event_number ASC`,
            [aggregateId, timestamp]
        );
        return result.rows;
    }
}

module.exports = new EventStore();
