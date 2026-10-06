
import { preserveHardLineBreaksInBlockquotes } from './markdown/blockquoteHardBreaks';
import { convertLeadingBulletsToListItems, splitInlineBulletPoints } from './markdown/bullets';
import { applyOutsideCommonFenceBlocks } from './markdown/fences';
import { escapeGfmTableCellPipes } from './markdown/gfmTables';
import { convertCompleteBrTagsToHardBreaks } from './markdown/lineBreakTags';
import { normalizeDoubleBackslashesInMathDelimiters } from './markdown/math';
import { cutAutolinksBeforeFullwidthPunctuation } from './markdown/autolinks';

export function preprocessMarkdown(source: string): string {
  const normalized = applyOutsideCommonFenceBlocks(source, normalizeDoubleBackslashesInMathDelimiters);
  const bulletLists = applyOutsideCommonFenceBlocks(normalized, (segment) =>
    splitInlineBulletPoints(convertLeadingBulletsToListItems(segment)));
  const tableSafe = applyOutsideCommonFenceBlocks(bulletLists, escapeGfmTableCellPipes);
  const linkSafe = applyOutsideCommonFenceBlocks(tableSafe, cutAutolinksBeforeFullwidthPunctuation);
  const brSafe = applyOutsideCommonFenceBlocks(linkSafe, convertCompleteBrTagsToHardBreaks);
  return applyOutsideCommonFenceBlocks(brSafe, preserveHardLineBreaksInBlockquotes);
}
