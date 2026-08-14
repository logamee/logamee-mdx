export { COMMON_MARKDOWN_FENCE_SPLIT_RE, applyOutsideCommonFenceBlocks } from './markdown/fences';
export { preserveHardLineBreaksInBlockquotes } from './markdown/blockquoteHardBreaks';
export { escapeCurrencyDollarSigns, normalizeDoubleBackslashesInMathDelimiters } from './markdown/math';
export { escapeGfmTableCellPipes, escapePipesInInlineCode, splitGfmTableRow } from './markdown/gfmTables';

import { preserveHardLineBreaksInBlockquotes } from './markdown/blockquoteHardBreaks';
import { applyOutsideCommonFenceBlocks } from './markdown/fences';
import { escapeGfmTableCellPipes } from './markdown/gfmTables';
import { normalizeDoubleBackslashesInMathDelimiters } from './markdown/math';

export function preprocessMarkdown(source: string): string {
  const normalized = applyOutsideCommonFenceBlocks(source, normalizeDoubleBackslashesInMathDelimiters);
  const tableSafe = applyOutsideCommonFenceBlocks(normalized, escapeGfmTableCellPipes);
  return applyOutsideCommonFenceBlocks(tableSafe, preserveHardLineBreaksInBlockquotes);
}
