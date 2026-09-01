import {
  deterministicJsonErrorCodes,
  type JsonValue,
} from './contracts.js';
import { DeterministicJsonError } from './errors.js';

export const assertJsonValue = (value: unknown): asserts value is JsonValue => {
  visitJsonValue(value, '$', new WeakSet(), false);
};

export const cloneSortedJsonValue = (value: unknown): JsonValue => (
  visitJsonValue(value, '$', new WeakSet(), true)
);

const visitJsonValue = (
  value: unknown,
  path: string,
  ancestors: WeakSet<object>,
  sortKeys: boolean,
): JsonValue => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new DeterministicJsonError(deterministicJsonErrorCodes.nonFiniteNumber, path);
    }
    return value;
  }
  if (typeof value !== 'object') {
    throw new DeterministicJsonError(
      deterministicJsonErrorCodes.invalidJsonValue,
      path,
      { valueType: typeof value },
    );
  }
  if (ancestors.has(value)) {
    throw new DeterministicJsonError(deterministicJsonErrorCodes.circularReference, path);
  }
  ancestors.add(value);
  try {
    return Array.isArray(value)
      ? visitArray(value, path, ancestors, sortKeys)
      : visitObject(value, path, ancestors, sortKeys);
  } finally {
    ancestors.delete(value);
  }
};

const visitArray = (
  value: readonly unknown[],
  path: string,
  ancestors: WeakSet<object>,
  sortKeys: boolean,
): readonly JsonValue[] => {
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Array.prototype) {
    throw new DeterministicJsonError(deterministicJsonErrorCodes.customPrototype, path);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === 'symbol')) {
    throw new DeterministicJsonError(deterministicJsonErrorCodes.symbolKey, path);
  }
  const extraKey = keys.find((key) => key !== 'length' && !isArrayIndex(key, value.length));
  if (extraKey !== undefined) {
    throw new DeterministicJsonError(
      deterministicJsonErrorCodes.invalidJsonValue,
      path,
      { property: extraKey },
    );
  }
  const output: JsonValue[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new DeterministicJsonError(
        deterministicJsonErrorCodes.sparseArray,
        `${path}[${String(index)}]`,
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new DeterministicJsonError(
        deterministicJsonErrorCodes.accessorProperty,
        `${path}[${String(index)}]`,
      );
    }
    output.push(visitJsonValue(descriptor.value, `${path}[${String(index)}]`, ancestors, sortKeys));
  }
  return output;
};

const visitObject = (
  value: object,
  path: string,
  ancestors: WeakSet<object>,
  sortKeys: boolean,
): { readonly [key: string]: JsonValue } => {
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new DeterministicJsonError(deterministicJsonErrorCodes.customPrototype, path);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key === 'symbol')) {
    throw new DeterministicJsonError(deterministicJsonErrorCodes.symbolKey, path);
  }
  const stringKeys = ownKeys.filter((key): key is string => typeof key === 'string');
  if (sortKeys) stringKeys.sort(compareCodeUnits);
  const output: Record<string, JsonValue> = {};
  for (const key of stringKeys) {
    const propertyPath = `${path}[${JSON.stringify(key)}]`;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new DeterministicJsonError(
        deterministicJsonErrorCodes.accessorProperty,
        propertyPath,
      );
    }
    if (!descriptor.enumerable) {
      throw new DeterministicJsonError(
        deterministicJsonErrorCodes.invalidJsonValue,
        propertyPath,
        { reason: 'non-enumerable-property' },
      );
    }
    output[key] = visitJsonValue(descriptor.value, propertyPath, ancestors, sortKeys);
  }
  return output;
};

const isArrayIndex = (key: PropertyKey, length: number): boolean => {
  if (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length;
};

const compareCodeUnits = (left: string, right: string): number => {
  if (left < right) return -1;
  return left > right ? 1 : 0;
};
