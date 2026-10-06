// 规格来源：markdown渲染规格参考第 1 节 —— 完整的 <br>/<br/>/<br /> 标签
// （段落中任意位置）换行；其余 HTML 标签按字面文字。行内代码内不动。

const COMPLETE_BR_RE = /<br>|<br\/>|<br \/>/g;

function splitOutsideInlineCode(segment: string): string[] {
  return segment.split(/(`[^`\n]*`)/g);
}

export function convertCompleteBrTagsToHardBreaks(segment: string): string {
  return splitOutsideInlineCode(segment)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part.replace(COMPLETE_BR_RE, () => '  \n'),
    )
    .join('');
}
