'use strict';

/**
 * BankAccount Aggregate
 *
 * This is the write-model aggregate. It reconstructs its state by
 * replaying a sequence of domain events. All business rule validation
 * happens here before a command produces new events.
 */
class BankAccount {
    constructor() {
        this.accountId = null;
        this.ownerName = null;
        this.balance = 0;
        this.currency = 'USD';
        this.status = null; // null | 'OPEN' | 'CLOSED'
        this.version = 0;   // the last applied event_number
        this.processedTransactionIds = new Set(); // for idempotency
    }

    // ----------------------------------------------------------------
    // Reconstitution from events
    // ----------------------------------------------------------------

    /**
     * Rebuild state by replaying a list of raw event rows from the DB.
     * @param {object[]} eventRows
     * @returns {BankAccount}
     */
    static fromEvents(eventRows) {
        const account = new BankAccount();
        for (const row of eventRows) {
            account._apply(row.event_type, row.event_data, row.event_number);
        }
        return account;
    }

    /**
     * Rebuild state from a snapshot, then replay subsequent events.
     * @param {object} snapshot  - A snapshots table row
     * @param {object[]} events  - Events after the snapshot's last_event_number
     * @returns {BankAccount}
     */
    static fromSnapshot(snapshot, events) {
        const account = new BankAccount();
        const data = snapshot.snapshot_data;
        account.accountId = data.accountId;
        account.ownerName = data.ownerName;
        account.balance = parseFloat(data.balance);
        account.currency = data.currency;
        account.status = data.status;
        account.version = snapshot.last_event_number;
        account.processedTransactionIds = new Set(data.processedTransactionIds || []);

        for (const row of events) {
            account._apply(row.event_type, row.event_data, row.event_number);
        }
        return account;
    }

    /**
     * Apply a single event to update in-memory state.
     */
    _apply(eventType, eventData, eventNumber) {
        switch (eventType) {
            case 'AccountCreated':
                this.accountId = eventData.accountId;
                this.ownerName = eventData.ownerName;
                this.balance = parseFloat(eventData.initialBalance || 0);
                this.currency = eventData.currency || 'USD';
                this.status = 'OPEN';
                break;

            case 'MoneyDeposited':
                this.balance = parseFloat((this.balance + parseFloat(eventData.amount)).toFixed(4));
                if (eventData.transactionId) {
                    this.processedTransactionIds.add(eventData.transactionId);
                }
                break;

            case 'MoneyWithdrawn':
                this.balance = parseFloat((this.balance - parseFloat(eventData.amount)).toFixed(4));
                if (eventData.transactionId) {
                    this.processedTransactionIds.add(eventData.transactionId);
                }
                break;

            case 'AccountClosed':
                this.status = 'CLOSED';
                break;

            default:
                // Unknown event – ignore (forward compatibility)
                break;
        }
        this.version = eventNumber;
    }

    // ----------------------------------------------------------------
    // Snapshot serialization
    // ----------------------------------------------------------------

    toSnapshot() {
        return {
            accountId: this.accountId,
            ownerName: this.ownerName,
            balance: this.balance,
            currency: this.currency,
            status: this.status,
            processedTransactionIds: Array.from(this.processedTransactionIds),
        };
    }

    // ----------------------------------------------------------------
    // Business rule validations (throw on failure)
    // ----------------------------------------------------------------

    /**
     * Validate that the account exists (has been created).
     */
    assertExists() {
        if (this.status === null) {
            const err = new Error('Account not found');
            err.status = 404;
            throw err;
        }
    }

    /**
     * Validate that the account is open.
     */
    assertOpen() {
        this.assertExists();
        if (this.status !== 'OPEN') {
            const err = new Error('Account is closed');
            err.status = 409;
            err.code = 'ACCOUNT_CLOSED';
            throw err;
        }
    }

    /**
     * Validate sufficient funds.
     */
    assertSufficientFunds(amount) {
        if (this.balance < parseFloat(amount)) {
            const err = new Error(
                `Insufficient funds: balance ${this.balance}, requested ${amount}`
            );
            err.status = 409;
            err.code = 'INSUFFICIENT_FUNDS';
            throw err;
        }
    }

    /**
     * Check idempotency – has this transactionId been processed?
     */
    hasProcessedTransaction(transactionId) {
        return this.processedTransactionIds.has(transactionId);
    }
}

module.exports = BankAccount;
