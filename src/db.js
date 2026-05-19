// Database connection module - manages MongoDB connection lifecycle.
// Supports both MONGODB_URI directly or Atlas credentials (MONGODB_USERNAME + MONGODB_PASSWORD).

import { MongoClient } from 'mongodb';

let client = null;
let db = null;

/**
 * Builds the MongoDB connection URI.
 * Priority: MONGODB_URI env var > Atlas credentials composition.
 */
function buildConnectionUri() {
  if (process.env.MONGODB_URI) {
    return process.env.MONGODB_URI;
  }

  const username = process.env.MONGODB_USERNAME;
  const password = process.env.MONGODB_PASSWORD;
  const cluster = process.env.MONGODB_CLUSTER || 'solution-agent.ikuk2cg.mongodb.net';
  const appName = process.env.MONGODB_APP_NAME || 'solution-agent';

  if (username && password) {
    return `mongodb+srv://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${cluster}/?retryWrites=true&w=majority&appName=${appName}`;
  }

  return 'mongodb://localhost:27017';
}

/**
 * Connects to MongoDB using the configured connection string.
 * @param {string} [uri] - MongoDB connection URI (overrides env vars)
 * @param {string} [dbName] - Database name (defaults to MONGODB_DB_NAME env var)
 * @returns {Promise<object>} The database instance
 */
export async function connectDb(uri, dbName) {
  const connectionUri = uri || buildConnectionUri();
  const databaseName = dbName || process.env.MONGODB_DB_NAME || 'tam-agent';

  client = new MongoClient(connectionUri);
  await client.connect();
  db = client.db(databaseName);
  console.log(`[db] Connected to MongoDB (database: ${databaseName})`);
  return db;
}

/**
 * Returns the current database instance.
 * @returns {object} The database instance
 * @throws {Error} If not connected
 */
export function getDb() {
  if (!db) {
    throw new Error('Database not connected. Call connectDb() first.');
  }
  return db;
}

/**
 * Returns the current MongoDB client.
 * @returns {object} The MongoClient instance
 */
export function getClient() {
  return client;
}

/**
 * Closes the database connection.
 * @returns {Promise<void>}
 */
export async function closeDb() {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}

export default { connectDb, getDb, getClient, closeDb };
