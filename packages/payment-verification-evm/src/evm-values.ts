export const maxUint256 = 2n ** 256n - 1n;

export function hexAddress(value: unknown): string | undefined {
  return typeof value === 'string' && /^0x[0-9a-f]{40}$/iu.test(value) ? value.toLowerCase() : undefined;
}

export function hexWord(value: unknown): string | undefined {
  return typeof value === 'string' && /^0x[0-9a-f]{64}$/iu.test(value) ? value.toLowerCase() : undefined;
}

export function hexData(value: unknown): string | undefined {
  return typeof value === 'string' && /^0x(?:[0-9a-f]{2})*$/iu.test(value) ? value.toLowerCase() : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
