// 规格来源：markdown渲染规格参考 2.3 —— 裸网址后紧跟全角标点时切断链接。
// 做法：把裸 URL 改写成显式链接，标点自然留在链接外；行内代码内的网址不动。

const FULLWIDTH_PUNCTUATION = '。，、；：！？）」』】';
const AUTOLINK_BEFORE_FULLWIDTH_RE = new RegExp(
  String.raw`(https?://[^\s<>()\[\]]+|www\.[^\s<>()\[\]]+)(?=[${FULLWIDTH_PUNCTUATION}])`,
  'g',
);

function splitOutsideInlineCode(segment: string): string[] {
  return segment.split(/(`[^`\n]*`)/g);
}

export function cutAutolinksBeforeFullwidthPunctuation(segment: string): string {
  return splitOutsideInlineCode(segment)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part.replace(AUTOLINK_BEFORE_FULLWIDTH_RE, (url) => `[${url}](${url})`),
    )
    .join('');
}
