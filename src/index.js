'use strict';
require('dotenv').config();

const app = require('./app');
const pool = require('./db');

const PORT = process.env.API_PORT || 8080;

async function startServer() {
    // Wait for the database to be ready
    let retries = 10;
    while (retries > 0) {
        try {
            await pool.query('SELECT 1');
            console.log('✅ Database connection established');
            break;
        } catch (err) {
            retries--;
            if (retries === 0) {
                console.error('❌ Could not connect to database after multiple retries:', err.message);
                process.exit(1);
            }
            console.log(`⏳ Waiting for database... (${retries} retries left)`);
            await new Promise((res) => setTimeout(res, 3000));
        }
    }

    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Bank Account API listening on port ${PORT}`);
        console.log(`   Health: http://localhost:${PORT}/health`);
    });
}

startServer();
