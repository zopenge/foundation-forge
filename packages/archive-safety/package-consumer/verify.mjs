import { inspectArchiveEntries } from '@openge/forge-archive-safety';

const report = inspectArchiveEntries([{ path: 'a.bin', kind: 'file', uncompressedBytes: 3 }]);
if (report.expandedBytes !== 3) throw new Error('archive safety consumer smoke failed');
