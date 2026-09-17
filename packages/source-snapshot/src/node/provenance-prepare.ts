import { prepareRepositorySnapshot } from './prepared-pipeline.js';
import type { PrepareRepositorySnapshotOptions } from './prepared-pipeline.js';
import { verifyRepositorySnapshotFreeze } from './pipeline.js';
import { SourceSnapshotError } from '../errors.js';
import { buildSnapshotProvenanceFromPlan } from './provenance-from-plan.js';
import type { ProvenanceCaptureOptions } from './provenance-from-plan.js';
/** 同次 prepare 的配置先复制；freeze 门不提供跨仓库原子时间点保证。 */
export const prepareSnapshotWithProvenance = async (
  options: PrepareRepositorySnapshotOptions,
  provenanceOptions: Omit<ProvenanceCaptureOptions, 'policy' | 'policyVersion'> = {},
) => {
  const { groupForPath, additionalSecretRules, signal, ...serializable } = options;
  const parameters = structuredClone(serializable); const stamps = structuredClone(provenanceOptions);
  const rules = additionalSecretRules?.map(rule => ({ ruleId: rule.ruleId, expression: new RegExp(rule.expression.source, rule.expression.flags),
    ...(rule.validate ? { validate: rule.validate } : {}) }));
  const captured = { ...parameters, groupForPath, ...(rules ? { additionalSecretRules: rules } : {}), ...(signal ? { signal } : {}) };
  const prepared = await prepareRepositorySnapshot(captured);
  try {
    if (!prepared.plan.publishAllowed) throw new SourceSnapshotError('COVERAGE_INVALID', { field: 'capture-blocked' });
    const freezeVerification = await verifyRepositorySnapshotFreeze(captured, prepared.plan.freeze);
    if (!freezeVerification.ok) throw new SourceSnapshotError('SOURCE_CHANGED', { field: 'provenance-freeze' });
    const bundle = await buildSnapshotProvenanceFromPlan(prepared.plan, { ...stamps, policy: parameters.policy, policyVersion: parameters.policyVersion }, 'same-operation');
    return Object.freeze({ ...bundle, prepared, freezeVerification });
  } catch (error) { await prepared.dispose(); throw error; }
};
