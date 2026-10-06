import React from 'react';
import type { Components } from 'react-markdown';
import type { Element as HastElement } from 'hast';
import type { JSX } from 'react';
import { mapH2ChildrenWrapHeadingSymbols } from '../../lib/headingPunct';
import { isLocalMarkdownExcalidrawEmbedSource } from '../../lib/markdownExcalidrawEmbed';
import type { ExcalidrawAssetSyncOptions } from '../../lib/excalidrawAssetSync';
import { isMemeMarkdownImageTitle } from '../../lib/markdownMemeImage';
import { isLocalMarkdownHtmlEmbedSource } from '../../lib/markdownHtmlEmbed';
import AdaptiveMarkdownImage from './AdaptiveMarkdownImage';
import { isMarkdownVideoSource, MarkdownVideo } from './MarkdownVideo';
import { MarkdownExcalidrawPreview } from './MarkdownExcalidrawPreview';
import { MarkdownHtmlFrame } from './MarkdownHtmlFrame';
import { CodeBlock } from './markdown/CodeBlock';
import { MemeImage } from './markdown/MemeImage';
import { MermaidDiagram } from './markdown/MermaidDiagram';
import { classNameToString, normalizeFenceLanguage, parseFenceLangTokenFromClasses } from './markdown/markdownLanguage';
import {
  BLOCKQUOTE_TREE_HEURISTIC_RE,
  extractText,
  hastCollectPlainText,
  isFenceCodeLike,
  paragraphIsSingleUrlLine,
  paragraphLooksLikeTextDiagram,
  slugify,
} from './markdown/markdownText';

export interface JinxiuMarkdownContext {
  currentFilePath: string | null;
  documentRelativePath: string | null;
  excalidrawAssetSync: ExcalidrawAssetSyncOptions | null;
  localAssetsEnabled: boolean;
  memeImagesEnabled: boolean;
  workspaceRoot: string | null;
}

type MdCodeProps = JSX.IntrinsicElements['code'] & { inline?: boolean; node?: unknown };

function headingAttributes(children: React.ReactNode, node?: HastElement) {
  const text = extractText(children);
  const line = node?.position?.start.line;
  return {
    'data-heading-key': text,
    'data-heading-slug': slugify(text),
    ...(typeof line === 'number' ? { 'data-heading-line': line } : {}),
  };
}

// Excalidraw 嵌入链接：无标题或 mmd:embed/mmd:source 且指向本地 .excalidraw。
function isExcalidrawEmbedLink(href: string | undefined, title: string | undefined, ctx: JinxiuMarkdownContext): boolean {
  return (title === undefined || title === 'mmd:embed' || title === 'mmd:source')
    && typeof href === 'string'
    && isLocalMarkdownExcalidrawEmbedSource(href, {
      currentFilePath: ctx.currentFilePath,
      workspaceRoot: ctx.workspaceRoot,
    });
}

// HTML 嵌入链接：mmd:embed 标题且指向本地 .html。
function isHtmlEmbedLink(href: string | undefined, title: string | undefined, ctx: JinxiuMarkdownContext): boolean {
  return title === 'mmd:embed'
    && typeof href === 'string'
    && isLocalMarkdownHtmlEmbedSource(href, {
      currentFilePath: ctx.currentFilePath,
      workspaceRoot: ctx.workspaceRoot,
    });
}

function jinxiuLink(props: React.AnchorHTMLAttributes<HTMLAnchorElement> & { children?: React.ReactNode }, ctx: JinxiuMarkdownContext): React.ReactNode {
  const { href, title, children: c, ...rest } = props;
  if (isExcalidrawEmbedLink(href, title, ctx)) {
    return (
      <MarkdownExcalidrawPreview
        currentFilePath={ctx.currentFilePath}
        documentRelativePath={ctx.documentRelativePath}
        enabled={ctx.localAssetsEnabled}
        excalidrawSrc={href as string}
        sync={title === 'mmd:source' ? ctx.excalidrawAssetSync : null}
        title={extractText(c).trim() || undefined}
        workspaceRoot={ctx.workspaceRoot}
      />
    );
  }
  if (isHtmlEmbedLink(href, title, ctx)) {
    return (
      <MarkdownHtmlFrame
        currentFilePath={ctx.currentFilePath}
        enabled={ctx.localAssetsEnabled}
        htmlSrc={href as string}
        title={extractText(c).trim() || undefined}
        workspaceRoot={ctx.workspaceRoot}
      />
    );
  }
  const external = typeof href === 'string' && (/^https?:\/\//i.test(href) || href.startsWith('//'));
  return <a href={href} title={title} {...rest} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>{c}</a>;
}

function jinxiuImage(props: React.ImgHTMLAttributes<HTMLImageElement> & { children?: React.ReactNode }, ctx: JinxiuMarkdownContext): React.ReactNode {
  const { src, alt, title, ...rest } = props;
  if (typeof src === 'string' && isMarkdownVideoSource(src)) {
    return <MarkdownVideo alt={alt ?? ''} className={typeof rest.className === 'string' ? rest.className : undefined} currentFilePath={ctx.currentFilePath} localAssetsEnabled={ctx.localAssetsEnabled} src={src} title={title} workspaceRoot={ctx.workspaceRoot} />;
  }
  if (ctx.memeImagesEnabled && isMemeMarkdownImageTitle(title)) {
    return <MemeImage {...rest} src={src} alt={alt ?? ''} currentFilePath={ctx.currentFilePath} localAssetsEnabled={ctx.localAssetsEnabled} workspaceRoot={ctx.workspaceRoot} />;
  }
  return <AdaptiveMarkdownImage {...rest} src={src} alt={alt ?? ''} title={title} currentFilePath={ctx.currentFilePath} localAssetsEnabled={ctx.localAssetsEnabled} workspaceRoot={ctx.workspaceRoot} />;
}

function jinxiuCode(props: MdCodeProps): React.ReactNode {
  const { className, children: c, node, inline, ...rest } = props;
  const classStr = classNameToString(className);
  const body = String(c).replace(/\n$/, '');
  const hastEl = (node as HastElement | undefined)?.type === 'element' ? (node as HastElement) : undefined;
  const isBlock = typeof inline === 'boolean' ? !inline : isFenceCodeLike(hastEl, classStr, body);
  if (!isBlock) return <code {...rest} className={classStr || undefined}>{c}</code>;
  const language = normalizeFenceLanguage(parseFenceLangTokenFromClasses(classStr));
  return language === 'mermaid'
    ? <MermaidDiagram code={body} />
    : <CodeBlock code={body} language={language} />;
}

function headingRenderer(tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6') {
  const Heading = tag;
  return ({ children: c, node, ...props }: { children?: React.ReactNode; node?: HastElement }) => (
    tag === 'h2'
      ? <Heading {...props} {...headingAttributes(c, node)}>{mapH2ChildrenWrapHeadingSymbols(c)}</Heading>
      : <Heading {...props} {...headingAttributes(c, node)}>{c}</Heading>
  );
}

// 组装 react-markdown 组件映射：标题锚点、段落启发式、链接/图片/代码渲染。
export function buildJinxiuComponents(ctx: JinxiuMarkdownContext): Components {
  return {
    h1: headingRenderer('h1'),
    h2: headingRenderer('h2'),
    h3: headingRenderer('h3'),
    h4: headingRenderer('h4'),
    h5: headingRenderer('h5'),
    h6: headingRenderer('h6'),
    pre: ({ children: c }) => <>{c}</>,
    p: ({ children: c, className, ...props }) => {
      const plain = extractText(c).trim();
      const cn = [paragraphIsSingleUrlLine(c) ? 'jinxiu-qa-p-url-nowrap' : '', paragraphLooksLikeTextDiagram(plain) ? 'jinxiu-text-diagram' : '', className].filter(Boolean).join(' ') || undefined;
      return <p {...props} className={cn}>{c}</p>;
    },
    a: (props) => jinxiuLink(props as Parameters<typeof jinxiuLink>[0], ctx),
    img: (props) => jinxiuImage(props as Parameters<typeof jinxiuImage>[0], ctx),
    iframe: ({ src, title }) => (
      <MarkdownHtmlFrame
        currentFilePath={ctx.currentFilePath}
        enabled={ctx.localAssetsEnabled}
        htmlSrc={src ?? ''}
        title={title}
        workspaceRoot={ctx.workspaceRoot}
      />
    ),
    blockquote: ({ node, children: c, className, ...props }) => {
      const cn = [className, BLOCKQUOTE_TREE_HEURISTIC_RE.test(hastCollectPlainText(node)) ? 'jinxiu-bq-tree' : ''].filter(Boolean).join(' ') || undefined;
      return <blockquote {...props} className={cn}>{c}</blockquote>;
    },
    code: (props) => jinxiuCode(props as MdCodeProps),
  };
}
