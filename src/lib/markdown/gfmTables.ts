const GFM_TABLE_SEPARATOR_RE = /^\s*\|?(?:\s*:?-{3,}:?\s*\|?)+\s*$/;

function isGfmTableRowLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return false;
  return /^\s*\|/.test(line) || /\|\s*$/.test(line) || GFM_TABLE_SEPARATOR_RE.test(trimmed);
}

function escapePipesInInlineCode(text: string): string {
  return text.replace(/`([^`\n]*)`/g, (_match, inner: string) => `\`${inner.replace(/(?<!\\)\|/g, '\\|')}\``);
}

// 行首跳过空白与可选竖线。
function skipLeadingPipeAndSpaces(line: string, start: number): number {
  let i = start;
  while (i < line.length && /[\t ]/.test(line[i]!)) i += 1;
  if (line[i] === '|') i += 1;
  while (i < line.length && /[\t ]/.test(line[i]!)) i += 1;
  return i;
}

// 竖线之后的空白终点；到达行尾返回 null。
function pipeTailIndex(line: string, from: number): number | null {
  let j = from;
  while (j < line.length && /[\t ]/.test(line[j]!)) j += 1;
  return j >= line.length ? null : j;
}

// 单字符累积：反引号翻转行内代码态，转义成对吞入，其余原样追加。
function accumulateCellChar(
  line: string,
  i: number,
  state: { buf: string; inBacktick: boolean },
): number {
  const ch = line[i]!;
  if (ch === '`') {
    state.inBacktick = !state.inBacktick;
    state.buf += ch;
    return i + 1;
  }
  if (ch === '\\' && i + 1 < line.length) {
    state.buf += ch + line[i + 1]!;
    return i + 2;
  }
  state.buf += ch;
  return i + 1;
}

export function splitGfmTableRow(line: string): string[] {
  const cells: string[] = [];
  const state = { buf: '', inBacktick: false };
  let i = skipLeadingPipeAndSpaces(line, 0);
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === '|' && !state.inBacktick) {
      if (pipeTailIndex(line, i + 1) === null) {
        const trimmed = state.buf.trim();
        if (trimmed) cells.push(trimmed);
        return cells;
      }
      cells.push(state.buf.trim());
      state.buf = '';
      i = skipLeadingPipeAndSpaces(line, i + 1);
      continue;
    }
    i = accumulateCellChar(line, i, state);
  }
  if (state.buf.length > 0 || cells.length === 0) cells.push(state.buf.trim().replace(/\|\s*$/, ''));
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
