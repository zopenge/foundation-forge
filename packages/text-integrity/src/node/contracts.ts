export interface TextIntegrityScanOptions {
  readonly cwd?: string;
  readonly ignoreLineMarker?: string;
  readonly ignoreMarkdownCodeSpans?: boolean;
  readonly ignoredDirectoryNames?: readonly string[];
  readonly ignoredPathPrefixes?: readonly string[];
  readonly additionalTextExtensions?: readonly string[];
  readonly additionalTextFileNames?: readonly string[];
  readonly concurrency?: number;
  readonly respectGitIgnore?: boolean;
}

export interface TextIntegrityCliOptions extends TextIntegrityScanOptions {
  readonly defaultPaths?: readonly string[];
  readonly writeError?: (message: string) => void;
}
