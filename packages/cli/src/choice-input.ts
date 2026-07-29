/**
 * Parse the exact numeric grammar advertised by CLI choice prompts. Anything
 * else remains user prose; numeric prefixes must never silently select an
 * option.
 */
export function parseChoiceIndexes(
  raw: string,
  optionCount: number,
  allowMultiple: boolean,
): number[] | null {
  const tokens = raw.split(",").map((token) => token.trim());
  if ((!allowMultiple && tokens.length !== 1) || tokens.length === 0) return null;
  if (tokens.some((token) => !/^\d+$/.test(token))) return null;

  const indexes = tokens.map((token) => Number(token) - 1);
  return indexes.every((index) => Number.isSafeInteger(index) && index >= 0 && index < optionCount)
    ? indexes
    : null;
}
