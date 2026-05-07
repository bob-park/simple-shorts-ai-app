import type { promises as FsPromises } from 'node:fs';

/** Minimal surface of Electron's safeStorage we depend on. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plaintext: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** Minimal fs surface for testability. */
type FsLike = Pick<typeof FsPromises, 'writeFile' | 'readFile' | 'unlink'>;

export class SecureStorage {
  constructor(
    private readonly filePath: string,
    private readonly safeStorage: SafeStorageLike,
    private readonly fs: FsLike,
  ) {}

  async hasKey(): Promise<boolean> {
    try {
      await this.fs.readFile(this.filePath);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw e;
    }
  }

  async setKey(plaintext: string): Promise<void> {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error('safeStorage encryption not available on this platform');
    }
    const encrypted = this.safeStorage.encryptString(plaintext);
    await this.fs.writeFile(this.filePath, encrypted);
  }

  async getKey(): Promise<string | null> {
    try {
      const encrypted = await this.fs.readFile(this.filePath);
      return this.safeStorage.decryptString(encrypted);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async clearKey(): Promise<void> {
    try {
      await this.fs.unlink(this.filePath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
}
