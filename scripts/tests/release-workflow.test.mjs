import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const releaseWorkflowUrl = new URL('../../.github/workflows/release.yml', import.meta.url);

test('pushes lightweight package tags created by the release script', async () => {
  const workflow = await readFile(releaseWorkflowUrl, 'utf8');

  assert.match(workflow, /run: git push origin --tags/u);
  assert.doesNotMatch(workflow, /git push --follow-tags/u);
});
