export type TextIntegrityIssueCode =
  | 'question-placeholder'
  | 'replacement-character'
  | 'private-use-character'
  | 'mojibake-token-cluster'
  | 'latin1-mojibake-cluster';

export interface TextIntegrityIssue {
  readonly file: string;
  readonly line: number;
  readonly code: TextIntegrityIssueCode;
  readonly preview: string;
}

export interface InspectTextIntegrityOptions {
  readonly filePath?: string;
  readonly ignoreLineMarker?: string;
  readonly ignoreMarkdownCodeSpans?: boolean;
}
