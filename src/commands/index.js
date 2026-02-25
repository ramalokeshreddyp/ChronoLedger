'use strict';
const BankAccount = require('../domain/BankAccount');
const eventStore = require('../eventStore');
const projector = require('../projectors');

const SNAPSHOT_THRESHOLD = 50;

// ----------------------------------------------------------------
// Helper: load aggregate (from snapshot + events or all events)
// ----------------------------------------------------------------
async function loadAggregate(accountId) {
    const snapshot = await eventStore.loadSnapshot(accountId);
    let account;

    if (snapshot) {
        const events = await eventStore.loadEvents(accountId, snapshot.last_event_number);
        account = BankAccount.fromSnapshot(snapshot, events);
    } else {
        const events = await eventStore.loadEvents(accountId, 0);
        account = BankAccount.fromEvents(events);
    }

    return account;
}

// ----------------------------------------------------------------
// Helper: persist events and run projections synchronously
// ----------------------------------------------------------------
async function saveAndProject(aggregateId, aggregateType, account, newEvents) {
    const persistedEvents = await eventStore.appendEvents(
        aggregateId,
        aggregateType,
        account.version,
        newEvents
    );

    // Update projections synchronously
    const totalEvents = await eventStore.countEvents();
    for (const eventRow of persistedEvents) {
        await projector.project(eventRow, totalEvents);
    }

    // Snapshotting strategy: snapshot after every SNAPSHOT_THRESHOLD events
    const latestVersion = persistedEvents[persistedEvents.length - 1].event_number;
    if (latestVersion % SNAPSHOT_THRESHOLD === 0) {
        // Reload aggregate to get accurate state at snapshot point
        const freshEvents = await eventStore.loadEvents(aggregateId, 0);
        const freshAccount = BankAccount.fromEvents(freshEvents);
        await eventStore.saveSnapshot(aggregateId, freshAccount.toSnapshot(), latestVersion);
    }

    return persistedEvents;
}

// ----------------------------------------------------------------
// Command: CreateAccount
// ----------------------------------------------------------------
async function createAccount({ accountId, ownerName, initialBalance = 0, currency = 'USD' }) {
    // Validate required fields
    if (!accountId || !ownerName) {
        const err = new Error('accountId and ownerName are required');
        err.status = 400;
        throw err;
    }

    // Check for duplicate
    const exists = await eventStore.aggregateExists(accountId);
    if (exists) {
        const err = new Error(`Account ${accountId} already exists`);
        err.status = 409;
        err.code = 'ACCOUNT_EXISTS';
        throw err;
    }

    if (parseFloat(initialBalance) < 0) {
        const err = new Error('initialBalance cannot be negative');
        err.status = 400;
        throw err;
    }

    const newEvents = [
        {
            eventType: 'AccountCreated',
            eventData: { accountId, ownerName, initialBalance: parseFloat(initialBalance), currency },
        },
    ];

    await saveAndProject(accountId, 'BankAccount', { version: 0 }, newEvents);
}

// ----------------------------------------------------------------
// Command: DepositMoney
// ----------------------------------------------------------------
async function depositMoney(accountId, { amount, description, transactionId }) {
    if (!amount || parseFloat(amount) <= 0) {
        const err = new Error('amount must be a positive number');
        err.status = 400;
        throw err;
    }
    if (!transactionId) {
        const err = new Error('transactionId is required');
        err.status = 400;
        throw err;
    }

    const account = await loadAggregate(accountId);
    account.assertOpen();

    // Idempotency: if transactionId already processed, return success quietly
    if (account.hasProcessedTransaction(transactionId)) {
        return; // Already applied – no-op
    }

    const newEvents = [
        {
            eventType: 'MoneyDeposited',
            eventData: { accountId, amount: parseFloat(amount), description: description || null, transactionId },
        },
    ];

    await saveAndProject(accountId, 'BankAccount', account, newEvents);
}

// ----------------------------------------------------------------
// Command: WithdrawMoney
// ----------------------------------------------------------------
async function withdrawMoney(accountId, { amount, description, transactionId }) {
    if (!amount || parseFloat(amount) <= 0) {
        const err = new Error('amount must be a positive number');
        err.status = 400;
        throw err;
    }
    if (!transactionId) {
        const err = new Error('transactionId is required');
        err.status = 400;
        throw err;
    }

    const account = await loadAggregate(accountId);
    account.assertOpen();

    // Idempotency
    if (account.hasProcessedTransaction(transactionId)) {
        return;
    }

    account.assertSufficientFunds(amount);

    const newEvents = [
        {
            eventType: 'MoneyWithdrawn',
            eventData: { accountId, amount: parseFloat(amount), description: description || null, transactionId },
        },
    ];

    await saveAndProject(accountId, 'BankAccount', account, newEvents);
}

// ----------------------------------------------------------------
// Command: CloseAccount
// ----------------------------------------------------------------
async function closeAccount(accountId, { reason }) {
    const account = await loadAggregate(accountId);
    account.assertOpen();

    if (Math.abs(account.balance) >= 0.0001) {
        const err = new Error(
            `Account balance must be zero to close. Current balance: ${account.balance}`
        );
        err.status = 409;
        err.code = 'NON_ZERO_BALANCE';
        throw err;
    }

    const newEvents = [
        {
            eventType: 'AccountClosed',
            eventData: { accountId, reason: reason || null },
        },
    ];

    await saveAndProject(accountId, 'BankAccount', account, newEvents);
}

module.exports = { createAccount, depositMoney, withdrawMoney, closeAccount };
