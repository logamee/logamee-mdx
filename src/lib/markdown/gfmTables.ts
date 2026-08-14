const GFM_TABLE_SEPARATOR_RE = /^\s*\|?(?:\s*:?-{3,}:?\s*\|?)+\s*$/;

function isGfmTableRowLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return false;
  return /^\s*\|/.test(line) || /\|\s*$/.test(line) || GFM_TABLE_SEPARATOR_RE.test(trimmed);
}

export function escapePipesInInlineCode(text: string): string {
  return text.replace(/`([^`\n]*)`/g, (_match, inner: string) => `\`${inner.replace(/(?<!\\)\|/g, '\\|')}\``);
}

export function splitGfmTableRow(line: string): string[] {
  const cells: string[] = [];
  let buf = '';
  let inBacktick = false;
  let i = 0;
  while (i < line.length && /[\t ]/.test(line[i]!)) i += 1;
  if (line[i] === '|') i += 1;
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === '`') {
      inBacktick = !inBacktick;
      buf += ch;
      i += 1;
      continue;
    }
    if (ch === '\\' && i + 1 < line.length) {
      buf += ch + line[i + 1]!;
      i += 2;
      continue;
    }
    if (ch === '|' && !inBacktick) {
      let j = i + 1;
      while (j < line.length && /[\t ]/.test(line[j]!)) j += 1;
      if (j >= line.length) {
        const trimmed = buf.trim();
        if (trimmed) cells.push(trimmed);
        return cells;
      }
      cells.push(buf.trim());
      buf = '';
      i += 1;
      while (i < line.length && /[\t ]/.test(line[i]!)) i += 1;
      continue;
    }
    buf += ch;
    i += 1;
  }
  if (buf.length > 0 || cells.length === 0) cells.push(buf.trim().replace(/\|\s*$/, ''));
  return cells;
}

function normalizeGfmTableRow(line: string, columnCount?: number): string {
  const cells = splitGfmTableRow(line);
  const normalized = columnCount != null && cells.length > columnCount
    ? [...cells.slice(0, columnCount - 1), cells.slice(columnCount - 1).join(' | ')]
    : cells;
  return `| ${normalized.map((cell) => escapePipesInInlineCode(cell)).join(' | ')} |`;
}

export function escapeGfmTableCellPipes(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const nextLine = lines[i + 1];
    if (!isGfmTableRowLine(line) || nextLine == null || !GFM_TABLE_SEPARATOR_RE.test(nextLine.trim())) {
      out.push(line);
      i += 1;
      continue;
    }

    const columnCount = splitGfmTableRow(line).length;
    out.push(normalizeGfmTableRow(line));
    out.push(nextLine);
    i += 2;

    while (i < lines.length && isGfmTableRowLine(lines[i]!)) {
      out.push(normalizeGfmTableRow(lines[i]!, columnCount));
      i += 1;
    }
  }
  return out.join('\n');
}
