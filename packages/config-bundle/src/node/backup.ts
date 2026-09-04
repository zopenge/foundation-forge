import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { files } from './files.js';
import { ensureDirectories, safeDirectories, statOrMissing } from './safe-target.js';
import { ConfigBundleError } from '../errors.js';
export async function writeExclusive(target: string, bytes: Uint8Array, owned: string[], directories: string[]): Promise<void> {
    await ensureDirectories(path.dirname(target), directories);
    await safeDirectories(path.dirname(target));
    const handle = await files.open(target, 'wx');
    owned.push(target);
    try {
        await handle.writeFile(bytes);
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    await safeDirectories(path.dirname(target));
    const stat = await statOrMissing(target);
    if (!stat || !stat.isFile() || stat.isSymbolicLink())
        throw new ConfigBundleError('CONFIG_BUNDLE_TARGET_UNSAFE', { path: target });
}
export async function stageFile(target: string, bytes: Uint8Array, owned: string[], directories: string[]): Promise<string> { const stage = path.join(path.dirname(target), '.forge-config-' + randomUUID() + '.tmp'); await writeExclusive(stage, bytes, owned, directories); return stage; }
