import {
  deterministicJsonErrorCodes,
  type DeterministicJsonStringifyOptions,
} from './contracts.js';
import { DeterministicJsonError } from './errors.js';
import { cloneSortedJsonValue } from './validation.js';

export const stringifyDeterministicJson = (
  value: unknown,
  options: DeterministicJsonStringifyOptions = {},
): string => {
  validateOptions(options);
  const serialized = JSON.stringify(cloneSortedJsonValue(value), null, options.space);
  return options.trailingNewline === true ? `${serialized}\n` : serialized;
};

const validateOptions = (options: DeterministicJsonStringifyOptions): void => {
  const { space } = options;
  if (
    space !== undefined
    && (
      (typeof space === 'number' && (!Number.isInteger(space) || space < 0 || space > 10))
      || (typeof space === 'string' && space.length > 10)
    )
  ) {
    throw new DeterministicJsonError(
      deterministicJsonErrorCodes.invalidOptions,
      '$',
      { option: 'space' },
    );
  }
};
