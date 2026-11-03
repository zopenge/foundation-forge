import { gunzipSync } from 'node:zlib';

/** 只解读测试自己捕获的有界官方 tar；不作为公开或不可信归档解压实现。 */
export function cliTarEntries(gzip: Buffer): { path: string; target: string; type: string; bytes: Buffer; mode: number }[] {
  const tar = gunzipSync(gzip, { maxOutputLength: 2_097_152 }), entries = [];
  const text = (bytes: Buffer) => bytes.subarray(0, bytes.indexOf(0) < 0 ? bytes.length : bytes.indexOf(0)).toString('utf8');
  let extended: Record<string, string> = {};
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512); if (header.every(byte => byte === 0)) break;
    const size = Number.parseInt(text(header.subarray(124, 136)).trim(), 8) || 0;
    const bytes = tar.subarray(offset + 512, offset + 512 + size); offset += 512 + Math.ceil(size / 512) * 512;
    const type = text(header.subarray(156, 157));
    if (type === 'x') {
      for (let start = 0; start < bytes.length;) {
        const space = bytes.indexOf(32, start), length = Number(bytes.subarray(start, space).toString());
        if (space < 0 || !Number.isSafeInteger(length) || length <= space - start + 1 || start + length > bytes.length) throw new Error('FIXTURE_PAX');
        const value = bytes.subarray(space + 1, start + length - 1).toString(), equal = value.indexOf('=');
        extended[value.slice(0, equal)] = value.slice(equal + 1); start += length;
      }
      continue;
    }
    const prefix = text(header.subarray(345, 500)), name = text(header.subarray(0, 100));
    entries.push({ path: extended.path ?? (prefix ? `${prefix}/${name}` : name),
      target: extended.linkpath ?? text(header.subarray(157, 257)), type, bytes, mode: Number.parseInt(text(header.subarray(100, 108)).trim(), 8) });
    extended = {};
  }
  return entries;
}
