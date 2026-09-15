import { validatePortableRelativePath } from '@openge/forge-path-safety';
import type { SourceSecretFinding, SourceSecretInput, SourceSecretRule } from './content-contracts.js';
import { SourceSnapshotError } from './errors.js';
const defaults: readonly SourceSecretRule[] = Object.freeze([
  { ruleId:'private-key', expression:/-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/gu },
  { ruleId:'github-token', expression:/\bgh[pousr]_[A-Za-z0-9]{30,255}\b/gu },
  { ruleId:'aws-access-key', expression:/\bAKIA[0-9A-Z]{16}\b/gu },
  { ruleId:'slack-token', expression:/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu },
  { ruleId:'bearer-token', expression:/\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}\b/gu, validate: value => { const token=value.replace(/^Bearer\s+/iu,''); return [/[a-z]/u.test(token),/[A-Z]/u.test(token),/[0-9]/u.test(token),/[._~+/-]/u.test(token)].filter(Boolean).length>=3; } },
  { ruleId:'credential-url', expression:/\b(?:https?|ssh):\/\/[^/\s:@]+:[^/\s@]{8,}@/gu },
]);
const location = (text:string,index:number): {line:number;column:number} => { const before=text.slice(0,index); const last=before.lastIndexOf('\n'); return { line: before.split('\n').length, column:index-last }; };
const normalizeRule = (rule: SourceSecretRule): SourceSecretRule => {
  if (typeof rule.ruleId !== 'string' || rule.ruleId.length===0 || !(rule.expression instanceof RegExp)) throw new SourceSnapshotError('INVALID_SECRET_RULE');
  const flags = rule.expression.flags.includes('g') ? rule.expression.flags : `${rule.expression.flags}g`;
  return Object.freeze({ ruleId:rule.ruleId, expression:new RegExp(rule.expression.source,flags), ...(rule.validate===undefined?{}:{validate:rule.validate}) });
};
export const scanSourceSecrets = (entries: readonly SourceSecretInput[], additionalRules: readonly SourceSecretRule[] = []): readonly SourceSecretFinding[] => {
  const rules=[...defaults,...additionalRules.map(normalizeRule)]; const findings:SourceSecretFinding[]=[];
  for (const entry of entries) { try { validatePortableRelativePath(entry.path); } catch { throw new SourceSnapshotError('INVALID_INPUT',{field:'path'}); }
    for (const sourceRule of rules) { const rule=normalizeRule(sourceRule); for (const match of entry.text.matchAll(rule.expression)) { const matched=match[0]; if (rule.validate!==undefined && !rule.validate(matched)) continue; const at=location(entry.text,match.index); findings.push(Object.freeze({severity:'block',ruleId:rule.ruleId,path:entry.path,line:at.line,column:at.column})); } }
  }
  return Object.freeze(findings.sort((a,b)=>a.path.localeCompare(b.path,'en')||a.line-b.line||a.column-b.column||a.ruleId.localeCompare(b.ruleId,'en')));
};
