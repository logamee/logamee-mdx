export interface ExportLimits {
  maxDocumentChars: number;
  maxHtmlBytes: number;
  maxImageBytes: number;
  maxPngPixels: number;
}

export const EXPORT_LIMITS: Readonly<ExportLimits> = Object.freeze({
  maxDocumentChars: 2_000_000,
  maxHtmlBytes: 32 * 1024 * 1024,
  maxImageBytes: 16 * 1024 * 1024,
  maxPngPixels: 80_000_000,
});

type ExportPreflightIssueKind = 'missing-image' | 'document-too-large' | 'diagram-error' | 'size-limit';

export interface ExportPreflightIssue {
  kind: ExportPreflightIssueKind;
  message: string;
  detail?: string;
}

export interface ExportPreflightInput {
  document: string;
  htmlBytes?: number;
  imageSources?: readonly { src: string; bytes?: number; available?: boolean }[];
  diagramErrors?: readonly string[];
  pngWidth?: number;
  pngHeight?: number;
  pngScale?: number;
  limits?: Partial<ExportLimits>;
}

type ExportLimitsBundle = ReturnType<typeof exportLimitsOf>;

function exportLimitsOf(input: ExportPreflightInput) {
  return { ...EXPORT_LIMITS, ...input.limits };
}

// 图片问题：不可用或超出单图字节上限。
function imagePreflightIssues(
  images: ExportPreflightInput['imageSources'],
  limits: ExportLimitsBundle,
): ExportPreflightIssue[] {
  const issues: ExportPreflightIssue[] = [];
  for (const image of images ?? []) {
    if (image.available === false) {
      issues.push({ kind: 'missing-image', message: 'An image could not be loaded.', detail: image.src });
    } else if (typeof image.bytes === 'number' && image.bytes > limits.maxImageBytes) {
      issues.push({ kind: 'size-limit', message: 'An image exceeds the export size limit.', detail: image.src });
    }
  }
  return issues;
}

// PNG 尺寸问题：缩放后像素总量超限。
function pngPreflightIssue(
  input: ExportPreflightInput,
  limits: ExportLimitsBundle,
): ExportPreflightIssue | null {
  if (input.pngWidth === undefined || input.pngHeight === undefined) return null;
  const scale = input.pngScale ?? 1;
  const pixels = Math.ceil(input.pngWidth * scale) * Math.ceil(input.pngHeight * scale);
  if (Number.isFinite(pixels) && pixels <= limits.maxPngPixels) return null;
  return { kind: 'size-limit', message: 'The PNG dimensions exceed the export limit.' };
}

export function collectExportPreflightIssues(input: ExportPreflightInput): ExportPreflightIssue[] {
  const limits = exportLimitsOf(input);
  const issues: ExportPreflightIssue[] = [];
  if (input.document.length > limits.maxDocumentChars) {
    issues.push({ kind: 'document-too-large', message: 'The document is too large to export safely.' });
  }
  if (typeof input.htmlBytes === 'number' && input.htmlBytes > limits.maxHtmlBytes) {
    issues.push({ kind: 'size-limit', message: 'The generated HTML exceeds the export size limit.' });
  }
  issues.push(...imagePreflightIssues(input.imageSources, limits));
  for (const error of input.diagramErrors ?? []) {
    issues.push({ kind: 'diagram-error', message: 'A diagram could not be rendered.', detail: error });
  }
  const pngIssue = pngPreflightIssue(input, limits);
  if (pngIssue) issues.push(pngIssue);
  return issues;
}
