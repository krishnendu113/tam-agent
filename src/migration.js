// PLACEHOLDER: This module should be replaced with the actual source from the source repository.
// Migration utilities - handles database schema migrations.

import { getDb } from './db.js';

/**
 * Runs all pending migrations.
 * @returns {Promise<Array>} List of applied migrations
 */
export async function runMigrations() {
  const db = getDb();
  const migrationsCol = db.collection('_migrations');

  const applied = await migrationsCol.find({}).toArray();
  const appliedNames = new Set(applied.map(m => m.name));

  const pending = getMigrations().filter(m => !appliedNames.has(m.name));

  const results = [];
  for (const migration of pending) {
    await migration.up(db);
    await migrationsCol.insertOne({
      name: migration.name,
      appliedAt: new Date()
    });
    results.push(migration.name);
  }

  return results;
}

/**
 * Returns the list of all defined migrations.
 * @returns {Array} Migration definitions
 */
export function getMigrations() {
  return [
    {
      name: '001_initial_collections',
      async up(db) {
        await db.createCollection('conversations');
        await db.createCollection('users');
        await db.createCollection('sessions');
      }
    }
  ];
}

export default { runMigrations, getMigrations };
