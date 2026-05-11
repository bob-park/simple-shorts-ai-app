#!/usr/bin/env tsx
/**
 * Cross-compile helper: downloads the Windows x64 prebuild of better-sqlite3
 * for the Electron version installed in this project.
 *
 * Equivalent to what `electron-rebuild --platform=win32 --arch=x64` would do
 * if the CLI exposed a --platform flag.  Invoked by `yarn rebuild:better-sqlite3:win`.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');

async function main(): Promise<void> {
  // Read the installed Electron version from its own package.json.
  const electronPkg = JSON.parse(
    await readFile(resolve(ROOT, 'node_modules/electron/package.json'), 'utf8'),
  ) as { version: string };
  const electronVersion = electronPkg.version;
  if (!electronVersion) {
    throw new Error('Could not read electron version from node_modules/electron/package.json');
  }

  // prebuild-install ships with better-sqlite3 itself; the top-level copy is
  // also fine — they are the same package resolved by Yarn.
  const prebuildBin = resolve(ROOT, 'node_modules/prebuild-install/bin.js');
  if (!existsSync(prebuildBin)) {
    throw new Error(`prebuild-install not found at ${prebuildBin} — run \`yarn install\``);
  }
  const modulePath = resolve(ROOT, 'node_modules/better-sqlite3');

  const args = [
    prebuildBin,
    `--arch=x64`,
    `--platform=win32`,
    `--runtime=electron`,
    `--target=${electronVersion}`,
    `--tag-prefix=v`,
  ];

  console.log(`Downloading better-sqlite3 Windows prebuild (electron ${electronVersion})…`);

  // Spawn with cwd set to the module directory so prebuild-install reads the
  // correct package.json (better-sqlite3's, not the project root's).
  // This mirrors how electron-rebuild invokes prebuild-install internally.
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit', cwd: modulePath });
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`prebuild-install exited ${code}`)),
    );
    child.on('error', reject);
  });

  console.log('✔ better-sqlite3 Windows prebuild installed.');
}

void main().catch((e) => {
  console.error('rebuild-sqlite3-win failed:', e);
  process.exit(1);
});
