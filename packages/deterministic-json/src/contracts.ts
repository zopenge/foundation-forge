export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export const deterministicJsonErrorCodes = {
  accessorProperty: 'ACCESSOR_PROPERTY',
  circularReference: 'CIRCULAR_REFERENCE',
  customPrototype: 'CUSTOM_PROTOTYPE',
  invalidJsonValue: 'INVALID_JSON_VALUE',
  invalidOptions: 'INVALID_OPTIONS',
  nonFiniteNumber: 'NON_FINITE_NUMBER',
  sparseArray: 'SPARSE_ARRAY',
  symbolKey: 'SYMBOL_KEY',
} as const;

export type DeterministicJsonErrorCode = typeof deterministicJsonErrorCodes[
  keyof typeof deterministicJsonErrorCodes
];

export interface DeterministicJsonStringifyOptions {
  readonly space?: number | string;
  readonly trailingNewline?: boolean;
}
