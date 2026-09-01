export const repositoryFilesErrorCodes = {
  gitCommandFailed: 'GIT_COMMAND_FAILED',
  gitUnavailable: 'GIT_UNAVAILABLE',
  invalidPath: 'INVALID_PATH',
  operationAborted: 'OPERATION_ABORTED',
  repositoryNotFound: 'REPOSITORY_NOT_FOUND',
} as const;

export type RepositoryFilesErrorCode = typeof repositoryFilesErrorCodes[keyof typeof repositoryFilesErrorCodes];

export interface RepositoryFilesOptions {
  readonly cwd?: string;
  readonly recurseSubmodules?: boolean;
  readonly signal?: AbortSignal;
}

export interface ChangedRepositoryFilesOptions {
  readonly cwd?: string;
  readonly includeDeleted?: boolean;
  readonly signal?: AbortSignal;
}

export interface RepositoryPathFilterOptions {
  readonly cwd?: string;
  readonly signal?: AbortSignal;
}

export interface RepositoryOperationOptions {
  readonly signal?: AbortSignal;
}
