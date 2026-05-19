// PLACEHOLDER: This module should be replaced with the actual source from the source repository.
// Store Factory - Provides backend-agnostic persistence adapters switchable via STORE_BACKEND env var.

import { createJsonStore } from './json/index.js';
import { createMongoStore } from './mongo/index.js';

/**
 * Creates a store instance based on the configured backend.
 * @param {string} collection - The collection/store name
 * @param {object} [options] - Additional store options
 * @returns {object} Store adapter with get, set, delete, list methods
 */
export function createStore(collection, options = {}) {
  const backend = process.env.STORE_BACKEND || 'json';

  switch (backend) {
    case 'mongodb':
    case 'mongo':
      return createMongoStore(collection, options);
    case 'json':
    default:
      return createJsonStore(collection, options);
  }
}

export default { createStore };
