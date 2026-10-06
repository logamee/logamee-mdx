export interface MarkdownEmbedContext {
  currentFilePath: string | null;
  workspaceRoot: string | null;
}

function trimPathEnd(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  if (normalized === '/' || /^[a-z]:\/$/i.test(normalized)) return normalized;
  return normalized.replace(/\/+$/, '');
}

// 当前文件的工作区相对父段（不含文件名），大小写按平台折叠；不在工作区内返回 null。
function workspaceRelativeParentSegments(
  rawWorkspaceRoot: string,
  rawCurrentFilePath: string,
): string[] | null {
  const workspaceRoot = trimPathEnd(rawWorkspaceRoot);
  const currentFilePath = trimPathEnd(rawCurrentFilePath);
  if (!workspaceRoot || !currentFilePath) return null;
  const caseInsensitive = /^[a-z]:\//i.test(workspaceRoot) || rawWorkspaceRoot.includes('\\');
  const comparableRoot = caseInsensitive ? workspaceRoot.toLowerCase() : workspaceRoot;
  const comparableFile = caseInsensitive ? currentFilePath.toLowerCase() : currentFilePath;
  const rootEndsWithSeparator = comparableRoot.endsWith('/');
  const rootPrefix = rootEndsWithSeparator ? comparableRoot : `${comparableRoot}/`;
  if (!comparableFile.startsWith(rootPrefix)) return null;
  const relativeFilePath = rootEndsWithSeparator
    ? currentFilePath.slice(workspaceRoot.length)
    : currentFilePath.slice(workspaceRoot.length + 1);
  return relativeFilePath.split('/').filter(Boolean).slice(0, -1);
}

// 以当前父段为起点回放 '..'：弹穿到工作区之外即失败。
function resolvedPathStaysInside(segments: string[], decodedSource: string): boolean {
  const resolvedSegments = [...segments];
  for (const component of decodedSource.split('/')) {
    if (!component || component === '.') continue;
    if (component === '..') {
      if (resolvedSegments.length === 0) return false;
      resolvedSegments.pop();
    } else {
      resolvedSegments.push(component);
    }
  }
  return true;
}

function parentPathStaysInsideWorkspace(
  decodedSource: string,
  context: MarkdownEmbedContext | undefined,
): boolean {
  if (!decodedSource.split('/').includes('..')) return true;
  if (!context?.currentFilePath || !context.workspaceRoot) return false;
  const parentSegments = workspaceRelativeParentSegments(context.workspaceRoot, context.currentFilePath);
  return parentSegments !== null && resolvedPathStaysInside(parentSegments, decodedSource);
}

// 源字符串预检：非空、无查询/锚点/反斜杠与编码的斜杠/反斜杠。
function embedSourceStringInvalid(source: string): boolean {
  return !source
    || source.includes('?')
    || source.includes('#')
    || source.includes('\\')
    || /%(?:2f|5c)/i.test(source);
}

// 解码后路径预检：无查询/锚点/反斜杠，且非绝对路径、家目录或带协议。
function decodedEmbedPathInvalid(path: string): boolean {
  return path.includes('?')
    || path.includes('#')
    || path.includes('\\')
    || path.startsWith('/')
    || path.startsWith('~')
    || /^[a-z][a-z\d+.-]*:/i.test(path);
}

// 编码段伪装检查：某段编码前不是 '..' 但解码后是。
function disguisedParentSegment(source: string): boolean {
  return source.split('/').some((component) => (
    component !== '..' && decodeURIComponent(component) === '..'
  ));
}

export function isLocalMarkdownEmbedSource(
  src: string,
  extensions: readonly string[],
  context?: MarkdownEmbedContext,
): boolean {
  const source = src.trim();
  if (embedSourceStringInvalid(source)) return false;
  let path: string;
  try {
    path = decodeURIComponent(source);
  } catch {
    return false;
  }
  if (disguisedParentSegment(source) || decodedEmbedPathInvalid(path)) return false;
  if (!parentPathStaysInsideWorkspace(path, context)) return false;
  const lowerPath = path.toLowerCase();
  return extensions.some((extension) => lowerPath.endsWith(`.${extension.toLowerCase()}`));
}
