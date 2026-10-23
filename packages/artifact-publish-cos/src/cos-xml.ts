import { XMLParser, XMLValidator } from 'cos-fast-xml-parser';
import { ArtifactPublicationError } from '@openge/forge-artifact-publish';

const parser = new XMLParser({
  ignoreAttributes: false, ignoreDeclaration: true, parseTagValue: false,
  trimValues: true, processEntities: false,
});

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function parseXml(bytes: Uint8Array): Record<string, unknown> {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (/<!DOCTYPE|<!ENTITY/iu.test(text) || XMLValidator.validate(text) !== true) throw new Error('invalid XML');
    const value: unknown = parser.parse(text);
    if (!record(value)) throw new Error('invalid document');
    return value;
  } catch { throw new ArtifactPublicationError('INVALID_REMOTE_RESPONSE'); }
}

export function assertNeverVersioned(bytes: Uint8Array): void {
  const document = parseXml(bytes);
  if (Object.keys(document).length !== 1 || !('VersioningConfiguration' in document)) throw new ArtifactPublicationError('INVALID_REMOTE_RESPONSE');
  const configuration = document.VersioningConfiguration;
  if (configuration === '') return;
  if (!record(configuration)
    || Object.keys(configuration).some(key => key !== 'Status' && key !== '@_xmlns')
    || ('@_xmlns' in configuration && configuration['@_xmlns'] !== 'http://cos.myqcloud.com/doc/2006-03-01/')) {
    throw new ArtifactPublicationError('INVALID_REMOTE_RESPONSE');
  }
  if ('Status' in configuration) throw new ArtifactPublicationError('IMMUTABILITY_UNSUPPORTED');
}

export function cosErrorCode(bytes: Uint8Array): string | undefined {
  const value = parseXml(bytes).Error;
  return record(value) && typeof value.Code === 'string' ? value.Code : undefined;
}
