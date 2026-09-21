export const value = 'fixture';

export function decodeSample(input: string): string {
  if (input.length === 0) throw new Error('invalid sample');
  return input;
}
