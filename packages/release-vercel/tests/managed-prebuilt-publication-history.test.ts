import { fixture } from './helpers/prebuilt-publication-fixture.js';
import { runRelease } from '../src/node.js';
import { ReleaseError } from '../src/node/errors.js';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('managed prebuilt candidate recovery through public entry', () => {
it.each(['lost-response', 'failed-job'])('keeps a proved old promotion settled after later candidates change the production alias: %s', async kind => {
    const value = await fixture();
    if (kind === 'lost-response') value.hooks.promote = () => { throw new ReleaseError('VERCEL_API'); };
    else value.hooks.failPromotion = true;
    const first = await runRelease({ command: 'publish', cwd: value.cwd, transport: value.transport });
    expect(first).toMatchObject({ ok: false, prebuilt: { promoteEffect: kind === 'lost-response' ? 'unknown' : 'accepted' } });
    delete value.hooks.promote; delete value.hooks.failPromotion;
    const observed = await runRelease({ command: 'status', cwd: value.cwd, transport: value.transport }); expect(observed.ok).toBe(kind === 'lost-response');
    for (const name of ['second', 'third']) {
      await writeFile(resolve(value.cwd, 'source.txt'), `${name}\n`); value.commit();
      const published = await runRelease({ command: 'publish', cwd: value.cwd, transport: value.transport });
      expect(published, JSON.stringify(published.error)).toMatchObject({ ok: true, prebuilt: { promotionVerified: true } });
    }
    expect(await value.creates()).toBe(3); expect(value.promotions()).toBe(3);
  }, 300_000);
});
