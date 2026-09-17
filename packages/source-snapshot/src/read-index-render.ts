import type { SnapshotReadIndex } from './read-index.js';

/** 渲染与行数统计共用逐行迭代，统计时不创建完整 Markdown 副本。 */
export function* readIndexLines(index: SnapshotReadIndex): Generator<string> {
  yield* ['# Source Snapshot', '', `- Snapshot ID: \`${index.snapshotId}\``, `- Source files: ${index.fileCount}`, '', '## Files', ''];
  for (const file of index.files) {
    yield `### \`${file.path}\``;
    yield '';
    yield `- Assurance: \`${file.assurance}\``;
    yield `- Format: v${file.formatVersion}`;
    yield `- Source SHA-256: \`${file.sourceSha256}\``;
    for (const object of file.objectRequirements) yield `- Object: \`${object.path}\` (${object.byteLength} bytes)`;
    for (const locator of file.locators) {
      yield `- Segment ${locator.segmentIndex}/${locator.segmentCount}: ` +
        `\`${locator.objectPath}\` body ${locator.bodyByteOffset}+${locator.bodyByteLength}; ` +
        `source lines ${locator.startLine}-${locator.endLine}`;
    }
    yield '';
  }
}
