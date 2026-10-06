import type { Mermaid, MermaidConfig } from 'mermaid';
import { getMermaidThemeConfig } from '../../../lib/mermaidTheme';
import { sanitizeMermaidSvg } from './mermaidSanitize';

export const MAX_MERMAID_SOURCE_LENGTH = 50_000;

const MERMAID_CONFIG = {
  // mermaid 12 将 ELK 设为默认布局、neo 设为默认外观；钉回 v11 渲染观感，
  // 避免既有文档图表在升级后重排与重新着色（DESIGN.md 预览契约）。
  layout: 'dagre',
  look: 'classic',
  flowchart: { htmlLabels: false },
  htmlLabels: false,
  logLevel: 'fatal',
  maxEdges: 500,
  maxTextSize: MAX_MERMAID_SOURCE_LENGTH,
  securityLevel: 'strict',
  secure: [
    'secure',
    'securityLevel',
    'startOnLoad',
    'maxTextSize',
    'maxEdges',
    'htmlLabels',
    'flowchart',
    'theme',
    'themeCSS',
    'themeVariables',
  ],
  startOnLoad: false,
} satisfies MermaidConfig;

interface MermaidRenderJob {
  readonly run: () => Promise<string>;
  readonly reject: (error: unknown) => void;
  readonly resolve: (svg: string) => void;
}

const mermaidRenderJobs: MermaidRenderJob[] = [];
let mermaidRenderActive = false;

let nextDiagramId = 0;

export function nextMermaidDiagramId(): string {
  nextDiagramId += 1;
  return `mmd-mermaid-${nextDiagramId}`;
}

function getMermaidApi(module: typeof import('mermaid')): Pick<Mermaid, 'initialize' | 'render'> {
  return module.default;
}

let mermaidApiPromise: Promise<Pick<Mermaid, 'initialize' | 'render'>> | null = null;

function loadMermaidApi(): Promise<Pick<Mermaid, 'initialize' | 'render'>> {
  mermaidApiPromise ??= import('mermaid').then(getMermaidApi);
  return mermaidApiPromise;
}

// 全局单飞队列：mermaid 渲染必须串行，避免全局 id 冲突。
function renderMermaid(
  mermaid: Pick<Mermaid, 'initialize' | 'render'>,
  config: MermaidConfig,
  renderId: string,
  code: string,
): Promise<string> {
  const result = new Promise<string>((resolve, reject) => {
    mermaidRenderJobs.push({
      reject,
      resolve,
      run: async () => {
        mermaid.initialize(config);
        const rendered = await mermaid.render(renderId, code);
        return rendered.svg;
      },
    });
  });
  if (!mermaidRenderActive) {
    mermaidRenderActive = true;
    void (async () => {
      while (mermaidRenderJobs.length > 0) {
        const job = mermaidRenderJobs.shift();
        if (!job) continue;
        try {
          job.resolve(await job.run());
        } catch (error) {
          job.reject(error);
        }
      }
      mermaidRenderActive = false;
    })();
  }
  return result;
}

export interface MermaidRenderRequest {
  code: string;
  container: HTMLElement;
  isCancelled: () => boolean;
  onFailed: () => void;
  onRendered: () => void;
  renderId: string;
  theme: { appearance: Parameters<typeof getMermaidThemeConfig>[1]; skin: Parameters<typeof getMermaidThemeConfig>[0] };
}

// 渲染管线：加载 mermaid → 串行渲染 → SVG 净化 → 挂载；取消后不再触碰容器。
export async function renderMermaidDiagram(request: MermaidRenderRequest): Promise<void> {
  try {
    const mermaid = await loadMermaidApi();
    if (request.isCancelled()) return;

    const svg = await renderMermaid(mermaid, {
      ...MERMAID_CONFIG,
      ...getMermaidThemeConfig(request.theme.skin, request.theme.appearance),
    }, request.renderId, request.code);
    if (request.isCancelled()) return;

    const fragment = sanitizeMermaidSvg(svg);
    if (fragment === null) throw new Error('Mermaid returned an unsafe SVG.');

    request.container.replaceChildren(fragment);
    request.onRendered();
  } catch {
    if (!request.isCancelled()) request.onFailed();
  }
}
