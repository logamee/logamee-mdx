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
    const bodies = [match[3] ?? ''];
    let j = i + 1;
    while (j < lines.length) {
      const next = BLOCKQUOTE_LINE_RE.exec(lines[j]!);
      if (!next) break;
      bodies.push(next[3] ?? '');
      j += 1;
    }
    let inDisplayMath = false;
    for (let k = 0; k < bodies.length; k += 1) {
      let body = bodies[k]!;
      const wasInDisplayMath = inDisplayMath;
      inDisplayMath = toggleDisplayMathBlockState(inDisplayMath, body);
      const trimmed = body.trim();
      const isInsideMathContent = wasInDisplayMath && inDisplayMath && trimmed !== '$$' && !/^\$\$[\s\S]+\$\$$/.test(trimmed);
      if (isInsideMathContent && k < bodies.length - 1 && !/\\\\\s*$/.test(body)) {
        body = body.trimEnd() + ' \\\\';
      }
      const addHardBreak = k !== bodies.length - 1 && !wasInDisplayMath && !inDisplayMath;
      out.push(addHardBreak ? `${indent}${marker}${body}  ` : `${indent}${marker}${body}`);
    }
    i = j;
  }
  return out.join('\n');
}
