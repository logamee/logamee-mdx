import { Component, lazy, Suspense, useCallback, useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import { useI18n } from '../../lib/i18n';
import { useObservedEffectiveTheme } from '../../lib/themeObservation';
import { normalizeFenceLanguage } from './markdownLanguage';

const SyntaxHighlightedCode = lazy(() => import('./SyntaxHighlightedCode'));

function PlainCodeFallback({ body, dark, language, loading }: { body: string; dark: boolean; language: string; loading: boolean }) {
  return (
    <pre
      aria-busy={loading}
      className="jinxiu-code-block-pre"
      style={{ margin: 0, borderRadius: 0, fontSize: '14px', lineHeight: 1.62, padding: '14px 16px 18px 0', backgroundColor: dark ? '#0d1117' : '#fff' }}
    >
      <code className={`jinxiu-fenced-code-inner language-${language}`}>{body}</code>
    </pre>
  );
}

class SyntaxHighlightErrorBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function CodeBlock({ code, language }: { code: string; language: string }) {
  const { t } = useI18n();
  const { appearance } = useObservedEffectiveTheme();
  const [copied, setCopied] = useState(false);
  const dark = appearance === 'dark';
  const body = code.replace(/\n$/, '');
  const lang = normalizeFenceLanguage(language);

  const copy = useCallback(async () => {
    if (!body.trim()) return;
    await navigator.clipboard.writeText(body);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }, [body]);

  return (
    <div className="jinxiu-code-copy-wrap markdown-code-block-copy-wrap jinxiu-code-surface">
      <button className="code-copy-button" type="button" onClick={copy} title={copied ? t('copied') : t('copyCode')} aria-label={copied ? t('copied') : t('copyCode')}>
        {copied ? <Check size={15} /> : <Copy size={15} />}
      </button>
      <SyntaxHighlightErrorBoundary fallback={<PlainCodeFallback body={body} dark={dark} language={lang} loading={false} />}>
        <Suspense fallback={<PlainCodeFallback body={body} dark={dark} language={lang} loading />}>
          <SyntaxHighlightedCode body={body} dark={dark} language={lang} />
        </Suspense>
      </SyntaxHighlightErrorBoundary>
    </div>
  );
}
