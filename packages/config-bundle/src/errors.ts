import type { ConfigBundleErrorCode } from './contracts.js';
export class ConfigBundleError extends Error {
    constructor(readonly code: ConfigBundleErrorCode, readonly details: Readonly<Record<string, unknown>> = {}, cause?: unknown) { super(code, { cause }); this.name = 'ConfigBundleError'; }
}
