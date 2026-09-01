import type { JsonValue } from './contracts.js';
import { cloneSortedJsonValue } from './validation.js';

export const sortJsonValue = (value: unknown): JsonValue => cloneSortedJsonValue(value);
