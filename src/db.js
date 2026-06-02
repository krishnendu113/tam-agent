// Database connection module - manages MongoDB/DocumentDB connection lifecycle.
// Supports DocumentDB with TLS (production) and plain MongoDB (local dev).
// STORE_BACKEND: "documentdb" (recommended), "mongodb" (deprecated alias), or "json" (flat files)

import { MongoClient } from 'mongodb';
import { existsSync } from 'fs';
import { resolve } from 'path';

let client = null;
let db = null;

/**
 * Determines whether DocumentDB backend is requested.
 * Handles "mongodb" as deprecated alias for "documentdb".
 * @returns {{ isDocDb: boolean, backend: string }}
 */
function resolveBackend() {
  const backend = (process.env.STORE_BACKEND || '').toLowerCase().trim();

  if (backend === 'mongodb') {
    console.warn(
      '[db] DEPRECATION WARNING: STORE_BACKEND="mongodb" is deprecated. Use "documentdb" instead.'
    );
    return { isDocDb: true, backend: 'documentdb' };
  }

  if (backend === 'documentdb') {
    return { isDocDb: true, backend: 'documentdb' };
  }

  return { isDocDb: false, backend };
}

/**
 * Validates that required DocumentDB env vars are present.
 * Throws a descriptive config error if missing.
 */
function validateDocDbConfig() {
  if (process.env.DOCDB_URI) {
    return; // Full URI provided — no further validation needed
  }

  const required = ['DOCDB_CLUSTER_ENDPOINT', 'DOCDB_USERNAME', 'DOCDB_PASSWORD'];
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(
      `[db] DocumentDB configuration error: Missing required environment variables: ${missing.join(', ')}. ` +
      `Either set DOCDB_URI with a full connection string, or provide all of: DOCDB_CLUSTER_ENDPOINT, DOCDB_USERNAME, DOCDB_PASSWORD.`
    );
  }
}

/**
 * Resolves the CA file path for TLS and validates its existence.
 * @returns {string} Absolute path to the CA certificate file
 * @throws {Error} If the CA file does not exist
 */
function resolveAndValidateCaFile() {
  const caFile = process.env.DOCDB_TLS_CA_FILE || './global-bundle.pem';
  const resolvedPath = resolve(caFile);

  if (!existsSync(resolvedPath)) {
    throw new Error(
      `[db] TLS CA certificate file not found at path: ${resolvedPath}. ` +
      `Set DOCDB_TLS_CA_FILE to the correct path or download the AWS RDS CA bundle.`
    );
  }

  return resolvedPath;
}

/**
 * Determines if TLS is enabled for DocumentDB connection.
 * @returns {boolean}
 */
function isTlsEnabled() {
  return process.env.DOCDB_TLS_ENABLED !== 'false';
}

/**
 * Builds the DocumentDB connection URI.
 * Priority: DOCDB_URI env var > composed from endpoint + credentials.
 * @param {string|null} caPath - Resolved CA file path (null if TLS disabled)
 * @returns {string} The connection URI
 */
export function buildDocumentDbUri(caPath) {
  if (process.env.DOCDB_URI) {
    return process.env.DOCDB_URI;
  }

  const endpoint = process.env.DOCDB_CLUSTER_ENDPOINT;
  const username = encodeURIComponent(process.env.DOCDB_USERNAME);
  const password = encodeURIComponent(process.env.DOCDB_PASSWORD);

  if (caPath) {
    return `mongodb://${username}:${password}@${endpoint}:27017/?tls=true&tlsCAFile=${caPath}&retryWrites=false&directConnection=true`;
  }

  // TLS disabled (local dev)
  return `mongodb://${username}:${password}@${endpoint}:27017/?retryWrites=false&directConnection=true`;
}

/**
 * Builds the legacy MongoDB connection URI (for non-DocumentDB backends).
 * Priority: MONGODB_URI env var > Atlas credentials composition > localhost.
 * @returns {string}
 */
function buildLegacyMongoUri() {
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
 * Connects to MongoDB/DocumentDB using the configured connection string.
 * @param {string} [uri] - Connection URI (overrides env-based resolution)
 * @param {string} [dbName] - Database name (defaults to MONGODB_DB_NAME env var)
 * @returns {Promise<object>} The database instance
 */
export async function connectDb(uri, dbName) {
  const databaseName = dbName || process.env.MONGODB_DB_NAME || 'tam-agent';
  const { isDocDb } = resolveBackend();

  let connectionUri;
  let tlsEnabled = false;
  let clientOptions = {};

  if (uri) {
    // Explicit URI provided — use as-is
    connectionUri = uri;
  } else if (isDocDb) {
    // DocumentDB backend
    validateDocDbConfig();
    tlsEnabled = isTlsEnabled();

    let caPath = null;
    if (tlsEnabled) {
      caPath = resolveAndValidateCaFile();
      clientOptions = {
        tls: true,
        tlsCAFile: caPath,
        retryWrites: false,
        directConnection: true,
      };
    } else {
      clientOptions = {
        retryWrites: false,
        directConnection: true,
      };
    }

    connectionUri = buildDocumentDbUri(caPath);
  } else {
    // Legacy MongoDB / localhost
    connectionUri = buildLegacyMongoUri();
  }

  client = new MongoClient(connectionUri, clientOptions);
  await client.connect();
  db = client.db(databaseName);

  if (isDocDb) {
    console.log(`[db] Connected to DocumentDB (database: ${databaseName}, tls: ${tlsEnabled})`);
  } else {
    console.log(`[db] Connected to MongoDB (database: ${databaseName})`);
  }

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
