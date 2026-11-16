import type { ArtifactContentIdentity } from '../content-contracts.js';
import type { ArtifactContentManifest } from '../content-manifest.js';

export type ArtifactCaptureFile = {
  readonly sourcePath: string;
  readonly path: string;
} & (
  | { readonly role: 'control' }
  | { readonly role: 'asset'; readonly responseHeaders: Readonly<Record<string, string>> }
);

export interface ArtifactCaptureSource {
  readonly rootDirectory: string;
  readonly closure: 'exact' | 'declared';
  readonly files: readonly ArtifactCaptureFile[];
}

export interface ArtifactFileCaptureOptions {
  readonly sources: readonly ArtifactCaptureSource[];
  readonly pathCaseSensitivity: 'case-sensitive' | 'case-insensitive';
  readonly maxFiles: number;
  /** 所有 exact 扫描累计访问的文件和目录条目数，包含前后两次扫描。 */
  readonly maxEntries: number;
  readonly maxFileBytes: number;
  /** 负载总字节加规范清单字节。 */
  readonly maxTotalBytes: number;
  readonly maxManifestBytes: number;
  readonly timeoutMilliseconds: number;
  readonly signal?: AbortSignal;
}

export interface ArtifactFileVerificationOptions extends ArtifactFileCaptureOptions {
  readonly manifestBytes: Uint8Array;
  readonly expectedContent: ArtifactContentIdentity;
}

export interface CapturedArtifactFiles {
  readonly manifest: ArtifactContentManifest;
  readonly content: ArtifactContentIdentity;
  readonly payloadByteLength: number;
  /** 每次读取返回副本；内部清单字节不可由调用方修改。 */
  readonly manifestBytes: Uint8Array;
  /** 返回指定逻辑路径的字节副本；不重新读取磁盘。 */
  readFile(path: string): Uint8Array;
}
