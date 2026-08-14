export interface MarkdownEmbedContext {
  currentFilePath: string | null;
  workspaceRoot: string | null;
}

function trimPathEnd(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  if (normalized === '/' || /^[a-z]:\/$/i.test(normalized)) return normalized;
  return normalized.replace(/\/+$/, '');
}

function parentPathStaysInsideWorkspace(
  decodedSource: string,
  context: MarkdownEmbedContext | undefined,
): boolean {
  if (!decodedSource.split('/').includes('..')) return true;
  if (!context?.currentFilePath || !context.workspaceRoot) return false;

  const workspaceRoot = trimPathEnd(context.workspaceRoot);
  const currentFilePath = trimPathEnd(context.currentFilePath);
  if (!workspaceRoot || !currentFilePath) return false;
  const caseInsensitive = /^[a-z]:\//i.test(workspaceRoot) || context.workspaceRoot.includes('\\');
  const comparableRoot = caseInsensitive ? workspaceRoot.toLowerCase() : workspaceRoot;
  const comparableFile = caseInsensitive ? currentFilePath.toLowerCase() : currentFilePath;
  const rootEndsWithSeparator = comparableRoot.endsWith('/');
  const rootPrefix = rootEndsWithSeparator ? comparableRoot : `${comparableRoot}/`;
  if (!comparableFile.startsWith(rootPrefix)) return false;

  const relativeFilePath = rootEndsWithSeparator
    ? currentFilePath.slice(workspaceRoot.length)
    : currentFilePath.slice(workspaceRoot.length + 1);
  const resolvedSegments = relativeFilePath.split('/').filter(Boolean).slice(0, -1);
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

export function isLocalMarkdownEmbedSource(
  src: string,
  extensions: readonly string[],
  context?: MarkdownEmbedContext,
): boolean {
  const source = src.trim();
  if (!source || source.includes('?') || source.includes('#') || source.includes('\\')) return false;
  if (/%(?:2f|5c)/i.test(source)) return false;

  let path: string;
  try {
    path = decodeURIComponent(source);
  } catch {
    return false;
  }
  if (source.split('/').some((component) => (
    component !== '..' && decodeURIComponent(component) === '..'
  ))) return false;
  if (path.includes('?') || path.includes('#') || path.includes('\\')) return false;
  if (path.startsWith('/') || path.startsWith('~') || /^[a-z][a-z\d+.-]*:/i.test(path)) return false;
  if (!parentPathStaysInsideWorkspace(path, context)) return false;

  const lowerPath = path.toLowerCase();
  return extensions.some((extension) => lowerPath.endsWith(`.${extension.toLowerCase()}`));
}
