import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const noOpReporter = {
  async recordGitTag() {},
};

export async function createChangesetsOutputReporter(outputPath) {
  if (!outputPath) {
    return noOpReporter;
  }

  const resolvedOutputPath = resolve(outputPath);
  await mkdir(dirname(resolvedOutputPath), { recursive: true });
  await writeFile(resolvedOutputPath, '', 'utf8');

  return {
    async recordGitTag(release) {
      const tag = `${release.name}@${release.version}`;
      await appendFile(
        resolvedOutputPath,
        `${JSON.stringify({ type: 'git-tag', tag, packageName: release.name })}\n`,
        'utf8',
      );
    },
  };
}
