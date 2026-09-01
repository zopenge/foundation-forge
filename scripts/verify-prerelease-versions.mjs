import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const packagePaths = [
  '../packages/peer-network/package.json',
  '../packages/peer-network-libp2p/package.json',
  '../packages/peer-network-websocket/package.json',
];

for (const relativePath of packagePaths) {
  const path = fileURLToPath(new URL(relativePath, import.meta.url));
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+-.+$/u.test(manifest.version)) {
    throw new Error(`${manifest.name ?? relativePath} must use a prerelease version`);
  }
}

console.log('All publishable packages use prerelease versions.');
