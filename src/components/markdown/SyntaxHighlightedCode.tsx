import { useMemo } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import supportedPrismLanguages from 'react-syntax-highlighter/dist/esm/languages/prism/supported-languages';
import oneLight from 'react-syntax-highlighter/dist/esm/styles/prism/one-light';
import oneDark from 'react-syntax-highlighter/dist/esm/styles/prism/one-dark';

type PrismStyleSheet = typeof oneLight;

const PRISM_LANG_SET = new Set(supportedPrismLanguages as unknown as string[]);

function effectivePrismLanguage(language: string): string {
  if (language === 'text') return 'text';
  return PRISM_LANG_SET.has(language) ? language : 'text';
}

function stripThemePreLayout(base: PrismStyleSheet): PrismStyleSheet {
  return { ...base, 'pre[class*="language-"]': {} };
}

function flatCodeSurface(base: PrismStyleSheet): PrismStyleSheet {
  const codeRule = base['code[class*="language-"]'];
  return codeRule ? { ...base, 'code[class*="language-"]': { ...codeRule, backgroundColor: 'transparent' } } : base;
}

export default function SyntaxHighlightedCode({ body, dark, language }: { body: string; dark: boolean; language: string }) {
  const prismStyle = useMemo(() => flatCodeSurface(stripThemePreLayout(dark ? oneDark : oneLight)), [dark]);

  return (
    <SyntaxHighlighter
      className="jinxiu-code-block-pre"
      language={effectivePrismLanguage(language)}
      style={prismStyle}
      PreTag="pre"
      showLineNumbers
      showInlineLineNumbers
      wrapLines
      customStyle={{ margin: 0, borderRadius: 0, fontSize: '14px', lineHeight: 1.62, padding: '14px 16px 18px 0', backgroundColor: dark ? '#0d1117' : '#fff' }}
      lineNumberStyle={{ minWidth: '3rem', paddingRight: '0.9rem', color: dark ? '#6e95c9' : '#1f82a6', userSelect: 'none' }}
      lineProps={{ className: 'jinxiu-code-line' }}
      codeTagProps={{
        className: 'jinxiu-fenced-code-inner',
        style: {
          overflowWrap: 'break-word',
          whiteSpace: 'pre-wrap',
          wordBreak: 'normal',
        },
      }}
    >
      {body}
    </SyntaxHighlighter>
  );
}
