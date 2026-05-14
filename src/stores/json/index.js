// PLACEHOLDER: This module should be replaced with the actual source from the source repository.
// JSON file-based store adapter for local development and testing.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const DATA_DIR = process.env.JSON_STORE_PATH || './data';

/**
 * Creates a JSON file-based store adapter.
 * @param {string} collection - The collection name (maps to a JSON file)
 * @param {object} [options] - Additional options
 * @returns {object} Store adapter with get, set, delete, list methods
 */
export function createJsonStore(collection, options = {}) {
  const filePath = join(DATA_DIR, `${collection}.json`);

  function ensureDir() {
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  function readData() {
    ensureDir();
    if (!existsSync(filePath)) {
      return {};
    }
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  }

  function writeData(data) {
    ensureDir();
    writeFileSync(filePath, JSON.stringify(data, null, 2));
  }

  return {
    async get(key) {
      const data = readData();
      return data[key] || null;
    },

    async set(key, value) {
      const data = readData();
      data[key] = value;
      writeData(data);
      return value;
    },

    async delete(key) {
      const data = readData();
      delete data[key];
      writeData(data);
      return true;
    },

    async list() {
      const data = readData();
      return Object.entries(data).map(([key, value]) => ({ key, ...value }));
    }
  };
}

export default { createJsonStore };
