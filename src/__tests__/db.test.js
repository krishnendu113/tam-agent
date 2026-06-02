import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock mongodb
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);
const mockDb = vi.fn().mockReturnValue({ collection: vi.fn() });

vi.mock('mongodb', () => ({
  MongoClient: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    close: mockClose,
    db: mockDb,
  })),
}));

// Mock fs
vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
}));

import { MongoClient } from 'mongodb';
import { existsSync } from 'fs';

describe('src/db.js', () => {
  let dbModule;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    // Reset environment
    delete process.env.STORE_BACKEND;
    delete process.env.DOCDB_URI;
    delete process.env.DOCDB_CLUSTER_ENDPOINT;
    delete process.env.DOCDB_USERNAME;
    delete process.env.DOCDB_PASSWORD;
    delete process.env.DOCDB_TLS_CA_FILE;
    delete process.env.DOCDB_TLS_ENABLED;
    delete process.env.MONGODB_URI;
    delete process.env.MONGODB_USERNAME;
    delete process.env.MONGODB_PASSWORD;
    delete process.env.MONGODB_CLUSTER;
    delete process.env.MONGODB_APP_NAME;
    delete process.env.MONGODB_DB_NAME;

    // Re-mock after resetModules
    vi.doMock('mongodb', () => ({
      MongoClient: vi.fn().mockImplementation(() => ({
        connect: mockConnect,
        close: mockClose,
        db: mockDb,
      })),
    }));

    vi.doMock('fs', () => ({
      existsSync: vi.fn().mockReturnValue(true),
    }));

    dbModule = await import('../db.js');
  });

  afterEach(async () => {
    // Close any open connections
    try {
      await dbModule.closeDb();
    } catch (_) {
      // ignore
    }
  });

  describe('resolveBackend behavior', () => {
    it('should treat STORE_BACKEND="documentdb" as DocumentDB', async () => {
      process.env.STORE_BACKEND = 'documentdb';
      process.env.DOCDB_CLUSTER_ENDPOINT = 'my-cluster.abc.us-east-1.docdb.amazonaws.com';
      process.env.DOCDB_USERNAME = 'admin';
      process.env.DOCDB_PASSWORD = 'secret';

      await dbModule.connectDb();

      const { MongoClient: MC } = await import('mongodb');
      const constructorCall = MC.mock.calls[MC.mock.calls.length - 1];
      expect(constructorCall[0]).toContain('my-cluster.abc.us-east-1.docdb.amazonaws.com');
    });

    it('should treat STORE_BACKEND="mongodb" as deprecated alias for documentdb', async () => {
      process.env.STORE_BACKEND = 'mongodb';
      process.env.DOCDB_CLUSTER_ENDPOINT = 'my-cluster.abc.us-east-1.docdb.amazonaws.com';
      process.env.DOCDB_USERNAME = 'admin';
      process.env.DOCDB_PASSWORD = 'secret';

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await dbModule.connectDb();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('DEPRECATION WARNING')
      );
      warnSpy.mockRestore();
    });

    it('should use legacy MongoDB when STORE_BACKEND is not documentdb/mongodb', async () => {
      process.env.STORE_BACKEND = 'json';

      await dbModule.connectDb();

      const { MongoClient: MC } = await import('mongodb');
      const constructorCall = MC.mock.calls[MC.mock.calls.length - 1];
      expect(constructorCall[0]).toBe('mongodb://localhost:27017');
    });
  });

  describe('DocumentDB URI construction', () => {
    it('should use DOCDB_URI when provided (takes priority)', async () => {
      process.env.STORE_BACKEND = 'documentdb';
      process.env.DOCDB_URI = 'mongodb://custom-uri:27017/mydb?tls=true';

      await dbModule.connectDb();

      const { MongoClient: MC } = await import('mongodb');
      const constructorCall = MC.mock.calls[MC.mock.calls.length - 1];
      expect(constructorCall[0]).toBe('mongodb://custom-uri:27017/mydb?tls=true');
    });

    it('should compose URI from endpoint + credentials with TLS', async () => {
      process.env.STORE_BACKEND = 'documentdb';
      process.env.DOCDB_CLUSTER_ENDPOINT = 'my-cluster.docdb.amazonaws.com';
      process.env.DOCDB_USERNAME = 'admin';
      process.env.DOCDB_PASSWORD = 'p@ss/word!';

      await dbModule.connectDb();

      const { MongoClient: MC } = await import('mongodb');
      const constructorCall = MC.mock.calls[MC.mock.calls.length - 1];
      const uri = constructorCall[0];

      expect(uri).toContain('mongodb://');
      expect(uri).toContain(encodeURIComponent('admin'));
      expect(uri).toContain(encodeURIComponent('p@ss/word!'));
      expect(uri).toContain('my-cluster.docdb.amazonaws.com:27017');
      expect(uri).toContain('tls=true');
      expect(uri).toContain('retryWrites=false');
      expect(uri).toContain('directConnection=true');
    });

    it('should URI-encode special characters in username and password', async () => {
      process.env.STORE_BACKEND = 'documentdb';
      process.env.DOCDB_CLUSTER_ENDPOINT = 'cluster.docdb.amazonaws.com';
      process.env.DOCDB_USERNAME = 'user@domain';
      process.env.DOCDB_PASSWORD = 'p@ss:w0rd/special#chars';

      await dbModule.connectDb();

      const { MongoClient: MC } = await import('mongodb');
      const constructorCall = MC.mock.calls[MC.mock.calls.length - 1];
      const uri = constructorCall[0];

      expect(uri).toContain(encodeURIComponent('user@domain'));
      expect(uri).toContain(encodeURIComponent('p@ss:w0rd/special#chars'));
    });
  });

  describe('TLS configuration', () => {
    it('should enable TLS by default when STORE_BACKEND=documentdb', async () => {
      process.env.STORE_BACKEND = 'documentdb';
      process.env.DOCDB_CLUSTER_ENDPOINT = 'cluster.docdb.amazonaws.com';
      process.env.DOCDB_USERNAME = 'admin';
      process.env.DOCDB_PASSWORD = 'secret';

      await dbModule.connectDb();

      const { MongoClient: MC } = await import('mongodb');
      const constructorCall = MC.mock.calls[MC.mock.calls.length - 1];
      const options = constructorCall[1];

      expect(options.tls).toBe(true);
      expect(options.retryWrites).toBe(false);
      expect(options.directConnection).toBe(true);
    });

    it('should use default CA path ./global-bundle.pem when DOCDB_TLS_CA_FILE is not set', async () => {
      process.env.STORE_BACKEND = 'documentdb';
      process.env.DOCDB_CLUSTER_ENDPOINT = 'cluster.docdb.amazonaws.com';
      process.env.DOCDB_USERNAME = 'admin';
      process.env.DOCDB_PASSWORD = 'secret';

      await dbModule.connectDb();

      const { MongoClient: MC } = await import('mongodb');
      const constructorCall = MC.mock.calls[MC.mock.calls.length - 1];
      const uri = constructorCall[0];

      expect(uri).toContain('tlsCAFile=');
      expect(uri).toContain('global-bundle.pem');
    });

    it('should use custom CA path from DOCDB_TLS_CA_FILE', async () => {
      process.env.STORE_BACKEND = 'documentdb';
      process.env.DOCDB_CLUSTER_ENDPOINT = 'cluster.docdb.amazonaws.com';
      process.env.DOCDB_USERNAME = 'admin';
      process.env.DOCDB_PASSWORD = 'secret';
      process.env.DOCDB_TLS_CA_FILE = '/custom/path/rds-ca.pem';

      await dbModule.connectDb();

      const { MongoClient: MC } = await import('mongodb');
      const constructorCall = MC.mock.calls[MC.mock.calls.length - 1];
      const options = constructorCall[1];

      expect(options.tlsCAFile).toBe('/custom/path/rds-ca.pem');
    });

    it('should connect without TLS when DOCDB_TLS_ENABLED=false', async () => {
      process.env.STORE_BACKEND = 'documentdb';
      process.env.DOCDB_CLUSTER_ENDPOINT = 'localhost';
      process.env.DOCDB_USERNAME = 'admin';
      process.env.DOCDB_PASSWORD = 'secret';
      process.env.DOCDB_TLS_ENABLED = 'false';

      await dbModule.connectDb();

      const { MongoClient: MC } = await import('mongodb');
      const constructorCall = MC.mock.calls[MC.mock.calls.length - 1];
      const uri = constructorCall[0];
      const options = constructorCall[1];

      expect(uri).not.toContain('tls=true');
      expect(uri).not.toContain('tlsCAFile');
      expect(options.tls).toBeUndefined();
      expect(options.retryWrites).toBe(false);
    });

    it('should throw if CA file does not exist and TLS is enabled', async () => {
      process.env.STORE_BACKEND = 'documentdb';
      process.env.DOCDB_CLUSTER_ENDPOINT = 'cluster.docdb.amazonaws.com';
      process.env.DOCDB_USERNAME = 'admin';
      process.env.DOCDB_PASSWORD = 'secret';

      // Re-mock fs to return false
      const { existsSync: mockExistsSync } = await import('fs');
      mockExistsSync.mockReturnValue(false);

      await expect(dbModule.connectDb()).rejects.toThrow('TLS CA certificate file not found');
    });
  });

  describe('configuration validation', () => {
    it('should throw if STORE_BACKEND=documentdb and no URI or credentials provided', async () => {
      process.env.STORE_BACKEND = 'documentdb';

      await expect(dbModule.connectDb()).rejects.toThrow('DocumentDB configuration error');
      await expect(dbModule.connectDb()).rejects.toThrow('DOCDB_CLUSTER_ENDPOINT');
    });

    it('should throw if only partial credentials provided', async () => {
      process.env.STORE_BACKEND = 'documentdb';
      process.env.DOCDB_CLUSTER_ENDPOINT = 'cluster.docdb.amazonaws.com';
      // Missing DOCDB_USERNAME and DOCDB_PASSWORD

      await expect(dbModule.connectDb()).rejects.toThrow('DOCDB_USERNAME');
      await expect(dbModule.connectDb()).rejects.toThrow('DOCDB_PASSWORD');
    });

    it('should not throw if DOCDB_URI is provided even without other vars', async () => {
      process.env.STORE_BACKEND = 'documentdb';
      process.env.DOCDB_URI = 'mongodb://full-connection-string:27017';
      process.env.DOCDB_TLS_ENABLED = 'false';

      await expect(dbModule.connectDb()).resolves.toBeDefined();
    });
  });

  describe('connectDb / getDb / closeDb API', () => {
    it('should return db instance from connectDb', async () => {
      const result = await dbModule.connectDb('mongodb://localhost:27017', 'test-db');
      expect(result).toBeDefined();
      expect(result.collection).toBeDefined();
    });

    it('should return same db instance from getDb after connect', async () => {
      await dbModule.connectDb('mongodb://localhost:27017', 'test-db');
      const dbInstance = dbModule.getDb();
      expect(dbInstance).toBeDefined();
    });

    it('should throw from getDb when not connected', () => {
      // Fresh module, not connected
      expect(() => dbModule.getDb()).toThrow('Database not connected');
    });

    it('should close connection and reset state', async () => {
      await dbModule.connectDb('mongodb://localhost:27017', 'test-db');
      await dbModule.closeDb();

      expect(() => dbModule.getDb()).toThrow('Database not connected');
    });

    it('should use MONGODB_DB_NAME env for database name', async () => {
      process.env.MONGODB_DB_NAME = 'custom-db';
      await dbModule.connectDb('mongodb://localhost:27017');

      expect(mockDb).toHaveBeenCalledWith('custom-db');
    });

    it('should default database name to tam-agent', async () => {
      await dbModule.connectDb('mongodb://localhost:27017');

      expect(mockDb).toHaveBeenCalledWith('tam-agent');
    });
  });

  describe('logging', () => {
    it('should log DocumentDB connection with TLS state', async () => {
      process.env.STORE_BACKEND = 'documentdb';
      process.env.DOCDB_CLUSTER_ENDPOINT = 'cluster.docdb.amazonaws.com';
      process.env.DOCDB_USERNAME = 'admin';
      process.env.DOCDB_PASSWORD = 'secret';

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await dbModule.connectDb();

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('DocumentDB')
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('tls: true')
      );
      logSpy.mockRestore();
    });

    it('should log MongoDB connection for non-documentdb backends', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await dbModule.connectDb('mongodb://localhost:27017');

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Connected to MongoDB')
      );
      logSpy.mockRestore();
    });
  });

  describe('buildDocumentDbUri export', () => {
    it('should build URI with TLS when caPath is provided', () => {
      process.env.DOCDB_CLUSTER_ENDPOINT = 'cluster.docdb.amazonaws.com';
      process.env.DOCDB_USERNAME = 'admin';
      process.env.DOCDB_PASSWORD = 'secret';

      const uri = dbModule.buildDocumentDbUri('/path/to/ca.pem');

      expect(uri).toBe(
        'mongodb://admin:secret@cluster.docdb.amazonaws.com:27017/?tls=true&tlsCAFile=/path/to/ca.pem&retryWrites=false&directConnection=true'
      );
    });

    it('should build URI without TLS when caPath is null', () => {
      process.env.DOCDB_CLUSTER_ENDPOINT = 'cluster.docdb.amazonaws.com';
      process.env.DOCDB_USERNAME = 'admin';
      process.env.DOCDB_PASSWORD = 'secret';

      const uri = dbModule.buildDocumentDbUri(null);

      expect(uri).toBe(
        'mongodb://admin:secret@cluster.docdb.amazonaws.com:27017/?retryWrites=false&directConnection=true'
      );
      expect(uri).not.toContain('tls=true');
    });
  });
});
