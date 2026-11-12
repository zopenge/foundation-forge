export interface DurableArtifactPublicationOptions {
  readonly mode: 'exclusive' | 'replace';
}

/** 根目录及其祖先命名空间由调用方控制，根目录本身须已持久存在。 */
export interface DurableArtifactFilesystem {
  ensureDirectory(rootDirectory: string, relativePath?: string): Promise<void>;
  publishBytes(rootDirectory: string, relativePath: string, content: Uint8Array, options: DurableArtifactPublicationOptions): Promise<void>;
}
