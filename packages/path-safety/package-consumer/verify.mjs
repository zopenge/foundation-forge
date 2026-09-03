import process from 'node:process';

import { validatePortableRelativePath } from '@openge/forge-path-safety';
import { resolvePathWithinRoot } from '@openge/forge-path-safety/node';

if (validatePortableRelativePath('assets/file.bin') !== 'assets/file.bin') {
  throw new Error('portable path consumer smoke failed');
}
const resolved = resolvePathWithinRoot(process.cwd(), 'assets/file.bin').replaceAll('\\', '/');
if (!resolved.endsWith('/assets/file.bin')) throw new Error('root containment consumer smoke failed');
