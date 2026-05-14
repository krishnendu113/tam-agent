// PLACEHOLDER: This module should be replaced with the actual source from the source repository.
// Database connection module - manages MongoDB connection lifecycle.

import { MongoClient } from 'mongodb';

let client = null;
let db = null;

/**
 * Connects to MongoDB using the configured connection string.
 * @param {string} [uri] - MongoDB connection URI (defaults to MONGODB_URI env var)
 * @param {string} [dbName] - Database name (defaults to MONGODB_DB_NAME env var)
 * @returns {Promise<object>} The database instance
 */
export async function connectDb(uri, dbName) {
  const connectionUri = uri || process.env.MONGODB_URI || 'mongodb://localhost:27017';
  const databaseName = dbName || process.env.MONGODB_DB_NAME || 'tam-agent';

  client = new MongoClient(connectionUri);
  await client.connect();
  db = client.db(databaseName);
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
