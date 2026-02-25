'use strict';
require('dotenv').config();
const { Pool } = require('pg');

const isRender = (process.env.DATABASE_URL || '').includes('render.com');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isRender ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error', err);
});

module.exports = pool;
