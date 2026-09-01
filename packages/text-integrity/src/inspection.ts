import type {
  InspectTextIntegrityOptions,
  TextIntegrityIssue,
  TextIntegrityIssueCode,
} from './contracts.js';

const defaultIgnoreLineMarker = 'check-mojibake-ignore-line';
const mojibakeCodePoints = new Set([
  0x20ac,
  0x52d4,
  0x589d,
  0x579a,
  0x5bee,
  0x5d87,
  0x641e,
  0x6471,
  0x6d63,
  0x6d93,
  0x6fc2,
  0x6fa7,
  0x71b8,
  0x72b2,
  0x7487,
  0x74a7,
  0x7586,
  0x7e0b,
  0x8930,
  0x8de8,
  0x92b0,
  0x9365,
  0x9422,
  0x95b0,
]);
const mojibakeFragments = [
  [0x9422, 0x71b8, 0x579a],
  [0x6d93, 0x20ac],
  [0x5bee, 0x72b2, 0x6d58],
  [0x7ec2, 0x4f79, 0x6471],
  [0x93c2, 0x677f, 0x589d],
  [0x7e5a, 0x9423],
  [0x93c3, 0x5d87],
  [0x9359, 0x5b2b],
].map((codePoints) => codePoints
  .map((codePoint) => String.fromCodePoint(codePoint))
  .join(''));
const mojibakeCharacters = [...mojibakeCodePoints]
  .map((codePoint) => String.fromCodePoint(codePoint))
  .join('');
const latin1MojibakePattern = /[ÃÂâäåæçèé][\u0080-\u00bf\u2018-\u201d\u2039\u203a\u00a0-\u00bf]/u;
const candidateLinePattern = new RegExp(
  `[?\\uFFFD\\u0080-\\u009F\\u00A0-\\u00BF\\uE000-\\uF8FFÃÂâäåæçèé${escapeCharacterClass(mojibakeCharacters)}]`,
  'u',
);

export const inspectTextIntegrity = (
  text: string,
  options: InspectTextIntegrityOptions = {},
): readonly TextIntegrityIssue[] => {
  const file = options.filePath ?? '<inline>';
  const ignoreLineMarker = options.ignoreLineMarker ?? defaultIgnoreLineMarker;
  const ignoreMarkdownCodeSpans = options.ignoreMarkdownCodeSpans ?? true;
  const issues: TextIntegrityIssue[] = [];

  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (ignoreLineMarker.length > 0 && line.includes(ignoreLineMarker)) {
      continue;
    }
    if (!candidateLinePattern.test(line)) {
      continue;
    }

    const lineNumber = index + 1;
    const inspectedLine = ignoreMarkdownCodeSpans ? stripMarkdownCodeSpans(line) : line;

    if (/\?{3,}/u.test(inspectedLine)) {
      issues.push(createIssue(file, lineNumber, 'question-placeholder', line));
    }
    if (inspectedLine.includes('\uFFFD')) {
      issues.push(createIssue(file, lineNumber, 'replacement-character', line));
    }
    if (/[\uE000-\uF8FF]/u.test(inspectedLine)) {
      issues.push(createIssue(file, lineNumber, 'private-use-character', line));
    }
    if (countMojibakeCodePoints(inspectedLine) >= 3 || containsMojibakeFragment(inspectedLine)) {
      issues.push(createIssue(file, lineNumber, 'mojibake-token-cluster', line));
    }
    if (latin1MojibakePattern.test(inspectedLine)) {
      issues.push(createIssue(file, lineNumber, 'latin1-mojibake-cluster', line));
    }
  }

  return issues;
};

const countMojibakeCodePoints = (line: string): number => {
  let count = 0;

  for (const character of line) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && mojibakeCodePoints.has(codePoint)) {
      count += 1;
    }
  }
  return count;
};

const containsMojibakeFragment = (line: string): boolean => mojibakeFragments
  .some((fragment) => line.includes(fragment));

const stripMarkdownCodeSpans = (line: string): string => line.replace(/`[^`]*`/gu, '');

const createIssue = (
  file: string,
  line: number,
  code: TextIntegrityIssueCode,
  source: string,
): TextIntegrityIssue => ({
  code,
  file,
  line,
  preview: source.trim().slice(0, 160),
});

function escapeCharacterClass(text: string): string {
  return text.replace(/[-\\\]^]/gu, '\\$&');
}
