/** 运行时中立的阅读目录入口，仅聚合公开合同。 */
export { buildSnapshotReadCatalog } from './read-catalog-build.js';
export { resolveSnapshotCatalog } from './read-catalog-resolve.js';
export { verifySnapshotReadCatalog } from './read-catalog-verify.js';
export { readSnapshotCatalogText } from './catalog-text-reader.js';
export type { CatalogTextReadResult } from './catalog-text-reader.js';
export type { CatalogArtifact, CatalogQuery, CatalogResolution, CatalogReadBudget, CatalogFile, CatalogAlias, CatalogLimits, ReadCatalogBundle, ReadCatalogOptions } from './read-catalog-contracts.js';
