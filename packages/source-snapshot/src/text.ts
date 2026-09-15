import type { DecodedSourceText } from './content-contracts.js';
import { SourceSnapshotError } from './errors.js';
const has = (bytes: Uint8Array, prefix: readonly number[]): boolean => prefix.every((value,index) => bytes[index] === value);
const decode = (label: string, bytes: Uint8Array): string => { try { return new TextDecoder(label, { fatal: true }).decode(bytes); } catch { throw new SourceSnapshotError('INVALID_TEXT_ENCODING'); } };
export const decodeSourceText = (input: Uint8Array): DecodedSourceText => {
  if (!(input instanceof Uint8Array)) throw new SourceSnapshotError('INVALID_INPUT', { field: 'bytes' });
  const bytes = Uint8Array.from(input);
  if (has(bytes,[0xef,0xbb,0xbf])) return Object.freeze({ text: decode('utf-8',bytes.subarray(3)), encoding:'utf8', bom:'utf8' });
  if (has(bytes,[0xff,0xfe])) { if ((bytes.length-2)%2!==0) throw new SourceSnapshotError('INVALID_TEXT_ENCODING'); return Object.freeze({ text: decode('utf-16le',bytes.subarray(2)), encoding:'utf16le', bom:'utf16le' }); }
  if (has(bytes,[0xfe,0xff])) { if ((bytes.length-2)%2!==0) throw new SourceSnapshotError('INVALID_TEXT_ENCODING'); return Object.freeze({ text: decode('utf-16be',bytes.subarray(2)), encoding:'utf16be', bom:'utf16be' }); }
  if (bytes.includes(0)) throw new SourceSnapshotError('BINARY_CONTENT');
  return Object.freeze({ text: decode('utf-8',bytes), encoding:'utf8', bom:null });
};
