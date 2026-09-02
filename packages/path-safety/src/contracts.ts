export const pathSafetyErrorCodes = {
  invalidRelativePath: 'INVALID_RELATIVE_PATH',
  pathEscape: 'PATH_ESCAPE',
  rootNotDirectory: 'ROOT_NOT_DIRECTORY',
  pathIoFailed: 'PATH_IO_FAILED',
} as const;

export type PathSafetyErrorCode = typeof pathSafetyErrorCodes[
  keyof typeof pathSafetyErrorCodes
];
