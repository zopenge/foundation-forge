import { TextDecoder, TextEncoder } from 'node:util';

import { decodeZipArchive, encodeZipArchive } from '@openge/forge-archive-zip';

const zip = encodeZipArchive([
  { bytes: new TextEncoder().encode('a'), kind: 'file', path: 'a.txt' },
], { compression: 'store' });
if (new TextDecoder().decode(decodeZipArchive(zip).entries[0].bytes) !== 'a') {
  throw new Error('ZIP archive consumer smoke failed');
}
