const BLOCKQUOTE_LINE_RE = /^(\s{0,3})((?:>\s?)+)(.*)$/;

function toggleDisplayMathBlockState(state: boolean, line: string): boolean {
  let inBlock = state;
  let i = 0;
  while (i < line.length) {
    const idx = line.indexOf('$$', i);
    if (idx === -1) break;
    inBlock = !inBlock;
    i = idx + 2;
  }
  return inBlock;
}

// 收集从 i 开始的连续引用行正文；返回正文数组与下一个非引用行下标。
function collectBlockquoteBodies(lines: string[], i: number): { bodies: string[]; next: number } {
  const bodies: string[] = [];
  let j = i;
  while (j < lines.length) {
    const match = BLOCKQUOTE_LINE_RE.exec(lines[j]!);
    if (!match) break;
    bodies.push(match[3] ?? '');
    j += 1;
  }
  return { bodies, next: j };
}

// 单条正文：数学块内补行尾双反斜杠；块间且非数学时补两个空格硬换行。
function blockquoteBodyLine(args: {
  body: string;
  indent: string;
  inDisplayMathAfter: boolean;
  inDisplayMathBefore: boolean;
  isInsideMathContent: boolean;
  isLast: boolean;
  marker: string;
}): { line: string } {
  const { indent, isLast, marker } = args;
  let body = args.body;
  if (args.isInsideMathContent && !isLast && !/\\\s*$/.test(body)) {
    body = body.trimEnd() + ' \\';
  }
  const addHardBreak = !isLast && !args.inDisplayMathBefore && !args.inDisplayMathAfter;
  return { line: addHardBreak ? `${indent}${marker}${body}  ` : `${indent}${marker}${body}` };
}

export function preserveHardLineBreaksInBlockquotes(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const match = BLOCKQUOTE_LINE_RE.exec(line);
    if (!match) {
      out.push(line);
      i += 1;
      continue;
    }
    const indent = match[1] ?? '';
    const marker = match[2] ?? '>';
    const { bodies, next } = collectBlockquoteBodies(lines, i + 1);
    bodies.unshift(match[3] ?? '');
    let inDisplayMath = false;
    for (let k = 0; k < bodies.length; k += 1) {
      const wasInDisplayMath = inDisplayMath;
      inDisplayMath = toggleDisplayMathBlockState(inDisplayMath, bodies[k]!);
      const trimmed = bodies[k]!.trim();
      const isInsideMathContent = wasInDisplayMath && inDisplayMath
        && trimmed !== '$$' && !/^\$\$[\s\S]+\$\$$/.test(trimmed);
      const { line: rendered } = blockquoteBodyLine({
        body: bodies[k]!,
        indent,
        inDisplayMathAfter: inDisplayMath,
        inDisplayMathBefore: wasInDisplayMath,
        isInsideMathContent,
        isLast: k === bodies.length - 1,
        marker,
      });
      out.push(rendered);
    }
    i = next;
  }
  return out.join('\n');
}
