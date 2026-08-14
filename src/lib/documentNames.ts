export const EMPTY_MARKDOWN = '# Untitled\n\nStart writing Markdown here.';

export function displayName(path: string | null): string {
  if (!path) return 'Untitled.md';
  return path.split(/[\\/]/).pop() || path;
}
