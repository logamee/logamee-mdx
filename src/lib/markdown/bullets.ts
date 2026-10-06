// 规格来源：markdown渲染规格参考 2.1 / 2.2 —— 行首圆点转列表、行内多要点拆分。

const LEADING_BULLET_RE = /^( {0,3})[•●○◆◇■□▪▫] /;

export function convertLeadingBulletsToListItems(segment: string): string {
  return segment
    .split('\n')
    .map((line) => line.replace(LEADING_BULLET_RE, '$1- '))
    .join('\n');
}

// 触发条件（全部满足才拆）：
// 1. 前缀以中英文冒号结尾（冒号后空格可选，验收样例 8 即无空格形态），
//    再跟 `-`/`*` 加空格加内容；
// 2. 内容里再出现“空格 + 符号 + 空格”分隔，或内容含任意空白。
export function splitInlineBulletPoints(segment: string): string {
  return segment
    .split('\n')
    .map((line) => {
      const match = /^([^`\n]*[:：]) ?([-*]) (.+)$/.exec(line);
      if (!match) return line;
      const [, prefix, marker, content] = match;
      const separator = ` ${marker} `;
      const rest = content.split(separator);
      const hasSecondSeparator = rest.length > 1;
      const hasWhitespace = /\s/.test(content);
      if (!hasSecondSeparator && !hasWhitespace) return line;
      return [prefix, ...rest.map((item) => `- ${item.trim()}`)].join('\n');
    })
    .join('\n');
}
