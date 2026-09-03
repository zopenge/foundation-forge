export interface ReadPnpmWorkspaceOptions {
  readonly cwd: string;
  readonly workspaceFile?: string;
}

export const workspacePnpmErrorCodes = {
  invalidPackageManifest: 'INVALID_PACKAGE_MANIFEST',
  invalidWorkspaceManifest: 'INVALID_WORKSPACE_MANIFEST',
  packageManifestMissing: 'PACKAGE_MANIFEST_MISSING',
  workspaceFileNotFound: 'WORKSPACE_FILE_NOT_FOUND',
} as const;

export type WorkspacePnpmErrorCode = typeof workspacePnpmErrorCodes[
  keyof typeof workspacePnpmErrorCodes
];
