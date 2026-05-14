// PLACEHOLDER: This module should be replaced with the actual source from the source repository.
// MongoDB store adapter for production persistence.

import { getDb } from '../../db.js';

/**
 * Creates a MongoDB-backed store adapter.
 * @param {string} collection - The MongoDB collection name
 * @param {object} [options] - Additional options
 * @returns {object} Store adapter with get, set, delete, list methods
 */
export function createMongoStore(collection, options = {}) {
  function getCollection() {
    const db = getDb();
    return db.collection(collection);
  }

  return {
    async get(key) {
      const col = getCollection();
      const doc = await col.findOne({ _id: key });
      return doc || null;
    },

    async set(key, value) {
      const col = getCollection();
      await col.updateOne(
        { _id: key },
        { $set: { ...value, _id: key, updatedAt: new Date() } },
        { upsert: true }
      );
      return value;
    },

    async delete(key) {
      const col = getCollection();
      await col.deleteOne({ _id: key });
      return true;
    },

    async list(filter = {}) {
      const col = getCollection();
      return col.find(filter).toArray();
    }
  };
}

export default { createMongoStore };
