import { beforeEach, describe, expect, it } from 'vitest';

import { SecureStorage } from './SecureStorage';

class FakeFs {
  private files = new Map<string, Buffer>();
  async writeFile(path: string, data: Buffer): Promise<void> {
    this.files.set(path, Buffer.from(data));
  }
  async readFile(path: string): Promise<Buffer> {
    const data = this.files.get(path);
    if (!data) {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }
    return data;
  }
  async unlink(path: string): Promise<void> {
    if (!this.files.delete(path)) {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }
  }
  has(path: string): boolean {
    return this.files.has(path);
  }
}

// Trivial reversible "encryption" so we can assert round-trip behavior.
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from('enc:' + s, 'utf8'),
  decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
};

describe('SecureStorage', () => {
  let fs: FakeFs;
  let storage: SecureStorage;
  const path = '/tmp/test-secrets.bin';

  beforeEach(() => {
    fs = new FakeFs();
    storage = new SecureStorage(path, fakeSafeStorage, fs as never);
  });

  it('hasKey() returns false when nothing is stored', async () => {
    expect(await storage.hasKey()).toBe(false);
  });

  it('setKey() encrypts and persists; getKey() decrypts and returns the original', async () => {
    await storage.setKey('sk-or-v1-abcdef');
    expect(await storage.hasKey()).toBe(true);
    expect(await storage.getKey()).toBe('sk-or-v1-abcdef');
  });

  it('clearKey() removes the file; subsequent hasKey() returns false', async () => {
    await storage.setKey('sk-or-v1-abcdef');
    await storage.clearKey();
    expect(await storage.hasKey()).toBe(false);
    expect(await storage.getKey()).toBeNull();
  });

  it('clearKey() is idempotent — clearing when already absent is not an error', async () => {
    await expect(storage.clearKey()).resolves.toBeUndefined();
  });

  it('throws when safeStorage encryption is unavailable', async () => {
    const unavailable = {
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => '',
    };
    const broken = new SecureStorage(path, unavailable, fs as never);
    await expect(broken.setKey('x')).rejects.toThrow(/encryption not available/i);
  });
});
