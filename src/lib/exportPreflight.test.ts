import { describe, expect, it } from 'vitest';
import { collectExportPreflightIssues } from './exportPreflight';

describe('collectExportPreflightIssues', () => {
  it('collects document, image, diagram and canvas failures together', () => {
    const issues = collectExportPreflightIssues({
      document: 'x'.repeat(11),
      imageSources: [{ src: 'missing.png', available: false }, { src: 'large.png', bytes: 101 }],
      diagramErrors: ['mermaid failed'],
      pngWidth: 20,
      pngHeight: 20,
      pngScale: 3,
      limits: { maxDocumentChars: 10, maxImageBytes: 100, maxPngPixels: 100 },
    });
    expect(issues.map((issue) => issue.kind)).toEqual([
      'document-too-large', 'missing-image', 'size-limit', 'diagram-error', 'size-limit',
    ]);
  });

  it('does not report healthy inputs', () => {
    expect(collectExportPreflightIssues({
      document: '# ok',
      imageSources: [{ src: 'ok.png', bytes: 10, available: true }],
      pngWidth: 10,
      pngHeight: 10,
      pngScale: 2,
      limits: { maxPngPixels: 1000 },
    })).toEqual([]);
  });
});

