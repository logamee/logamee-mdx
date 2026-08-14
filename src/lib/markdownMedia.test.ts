import { describe, expect, it } from 'vitest';
import {
  createMarkdownImageReference,
  createMarkdownExcalidrawAssetReference,
  createMarkdownMediaDestination,
  createMarkdownMediaReference,
  decodeMarkdownMediaCursorInsertion,
  decodeMarkdownMediaInsertionHandshake,
  decodeMarkdownMediaInsertionReady,
  decodeMarkdownMediaInsertionReadyRequest,
  resolveWorkspaceRelativeMediaPath,
} from './markdownMedia';

const markdownDocument = { relative_path: 'guide.md' };

describe('Markdown media references', () => {
  it('creates an image reference from a backend-authorized document-relative path', () => {
    expect(createMarkdownImageReference(
      'clipboard [final].png',
      '../../shared assets/clipboard (final).png',
    )).toBe('![clipboard \\[final\\].png](../../shared%20assets/clipboard%20%28final%29.png)');
    expect(createMarkdownImageReference('private.png', '/tmp/private.png')).toBeNull();
    expect(createMarkdownImageReference('private.png', 'file:///tmp/private.png')).toBeNull();
  });

  it('creates an image reference from a workspace-relative asset path', () => {
    expect(createMarkdownMediaReference({
      kind: 'image',
      name: 'cover image.png',
      relative_path: 'assets/cover image.png',
    }, markdownDocument)).toBe('![cover image.png](assets/cover%20image.png)');
  });

  it('escapes Markdown destination punctuation in an image path', () => {
    expect(createMarkdownMediaReference({
      kind: 'image',
      name: 'cover (final).png',
      relative_path: 'assets/cover (final).png',
    }, markdownDocument)).toBe('![cover (final).png](assets/cover%20%28final%29.png)');
  });

  it('creates an unambiguous reference relative to a nested Markdown document', () => {
    expect(createMarkdownMediaReference({
      kind: 'image',
      name: 'cover.png',
      relative_path: 'assets/cover.png',
    }, {
      relative_path: 'docs/guide.md',
    })).toBe('![cover.png](../assets/cover.png)');
  });

  it('creates a portable Markdown link for an audio asset', () => {
    expect(createMarkdownMediaReference({
      kind: 'audio',
      name: 'opening theme.mp3',
      relative_path: 'audio/opening theme.mp3',
    }, markdownDocument)).toBe('[opening theme.mp3](audio/opening%20theme.mp3)');
  });

  it('escapes Markdown destination punctuation in an audio path', () => {
    expect(createMarkdownMediaReference({
      kind: 'audio',
      name: 'intro (v2).mp3',
      relative_path: 'audio/intro (v2).mp3',
    }, markdownDocument)).toBe('[intro (v2).mp3](audio/intro%20%28v2%29.mp3)');
  });

  it('creates an interactive embed reference for a local HTML file', () => {
    expect(createMarkdownMediaReference({
      kind: 'html',
      name: 'demo page.html',
      relative_path: 'demos/demo page.html',
    }, {
      relative_path: 'docs/guide.md',
    })).toBe('[demo page.html](../demos/demo%20page.html "mmd:embed")');
  });

  it('creates an embed reference for an Excalidraw file', () => {
    expect(createMarkdownMediaReference({
      kind: 'excalidraw',
      name: 'system diagram.excalidraw',
      relative_path: 'diagrams/system diagram.excalidraw',
    }, {
      relative_path: 'docs/guide.md',
    })).toBe('[system diagram.excalidraw](../diagrams/system%20diagram.excalidraw "mmd:embed")');
  });

  it('creates a source-linked Excalidraw SVG reference with a PNG sidecar manifest', () => {
    const reference = createMarkdownExcalidrawAssetReference({
      document: { relative_path: 'docs/guide.md' },
      name: 'system diagram',
      pngMarkdownPath: '../assets/excalidraw-assets/system.png',
      scale: 2,
      sourceRelativePath: 'diagrams/system.excalidraw',
      sourceSha256: 'a'.repeat(64),
      svgMarkdownPath: '../assets/excalidraw-assets/system.svg',
    });

    expect(reference).toContain('<!-- mmd:excalidraw ');
    expect(reference).toContain('../assets/excalidraw-assets/system.svg?mmdSource=' + 'a'.repeat(64));
    expect(reference).toContain('](../diagrams/system.excalidraw "mmd:source")');
    expect(reference).toContain('%22sourceRelativePath%22%3A%22diagrams%2Fsystem.excalidraw%22');
    expect(reference).not.toContain('%2D%2D');
  });

  it('exposes the encoded source destination for sidecar synchronization', () => {
    expect(createMarkdownMediaDestination({
      kind: 'excalidraw',
      name: 'system.excalidraw',
      relative_path: 'diagrams/system.excalidraw',
    }, { relative_path: 'docs/guide.md' })).toBe('../diagrams/system.excalidraw');
  });

  it('resolves a generated source link back to a workspace-relative path', () => {
    expect(resolveWorkspaceRelativeMediaPath('docs/guide.md', '../diagrams/system%20diagram.excalidraw'))
      .toBe('diagrams/system diagram.excalidraw');
    expect(resolveWorkspaceRelativeMediaPath('guide.md', '../../outside.excalidraw')).toBeNull();
    expect(resolveWorkspaceRelativeMediaPath('guide.md', 'file:///tmp/diagram.excalidraw')).toBeNull();
  });

  it('rejects unsupported assets and unsafe workspace paths', () => {
    expect(createMarkdownMediaReference({
      kind: 'video',
      name: 'clip.mp4',
      relative_path: 'media/clip.mp4',
    }, markdownDocument)).toBeNull();
    expect(createMarkdownMediaReference({
      kind: 'image',
      name: 'private.png',
      relative_path: '../private.png',
    }, markdownDocument)).toBeNull();
  });

  it('decodes a validated cursor insertion event', () => {
    const insertion = {
      asset: {
        kind: 'html',
        name: 'demo.html',
        relative_path: 'demos/demo.html',
      },
      documentRelativePath: 'docs/guide.md',
      documentEpoch: 3,
      documentId: 'pane-document:3',
      popoutInstanceId: 'popout-instance:3',
      requestId: 9,
    };

    expect(decodeMarkdownMediaCursorInsertion(insertion)).toEqual(insertion);
  });

  it('decodes a validated popout-ready event', () => {
    expect(decodeMarkdownMediaInsertionReady({
      documentEpoch: 3,
      documentId: 'pane-document:3',
      popoutInstanceId: 'popout-instance:3',
    })).toEqual({
      documentEpoch: 3,
      documentId: 'pane-document:3',
      popoutInstanceId: 'popout-instance:3',
    });
    expect(decodeMarkdownMediaInsertionReady({
      documentEpoch: 3,
      documentId: 'pane document',
      popoutInstanceId: 'popout-instance:3',
    })).toBeNull();
    expect(decodeMarkdownMediaInsertionReady({
      documentEpoch: 3,
      documentId: 'pane-document:3',
      popoutInstanceId: 'popout-instance:3',
      readyRequestId: 'ready-request:3',
    })).toEqual({
      documentEpoch: 3,
      documentId: 'pane-document:3',
      popoutInstanceId: 'popout-instance:3',
      readyRequestId: 'ready-request:3',
    });
  });

  it('decodes only exact popout-ready request payloads', () => {
    expect(decodeMarkdownMediaInsertionReadyRequest({
      documentEpoch: 3,
      documentId: 'pane-document:3',
      readyRequestId: 'ready-request:3',
    })).toEqual({
      documentEpoch: 3,
      documentId: 'pane-document:3',
      readyRequestId: 'ready-request:3',
    });
    expect(decodeMarkdownMediaInsertionReadyRequest({
      documentEpoch: 3,
      documentId: 'pane-document:3',
      popoutInstanceId: 'untrusted',
    })).toBeNull();
  });

  it('decodes only exact insertion handshake payloads', () => {
    const handshake = {
      documentEpoch: 3,
      documentId: 'pane-document:3',
      handshakeId: 'markdown-media-handshake:9',
      popoutInstanceId: 'popout-instance:3',
    };

    expect(decodeMarkdownMediaInsertionHandshake(handshake)).toEqual(handshake);
    expect(decodeMarkdownMediaInsertionHandshake({
      ...handshake,
      handshakeId: 'invalid handshake',
    })).toBeNull();
    expect(decodeMarkdownMediaInsertionHandshake({
      ...handshake,
      extra: true,
    })).toBeNull();
  });

  it.each([
    { asset: { kind: 'html', name: 'demo.html', relative_path: '../demo.html' }, documentRelativePath: 'docs/guide.md', documentEpoch: 3, documentId: 'pane-document:3', popoutInstanceId: 'popout-instance:3', requestId: 9 },
    { asset: { kind: 'video', name: 'demo.mp4', relative_path: 'demos/demo.mp4' }, documentRelativePath: 'docs/guide.md', documentEpoch: 3, documentId: 'pane-document:3', popoutInstanceId: 'popout-instance:3', requestId: 9 },
    { asset: { kind: 'html', name: '', relative_path: 'demos/demo.html' }, documentRelativePath: 'docs/guide.md', documentEpoch: 3, documentId: 'pane-document:3', popoutInstanceId: 'popout-instance:3', requestId: 9 },
    { asset: { kind: 'html', name: 'demo.html', relative_path: 'demos/demo.html' }, documentRelativePath: '../guide.md', documentEpoch: 3, documentId: 'pane-document:3', popoutInstanceId: 'popout-instance:3', requestId: 9 },
    { asset: { kind: 'html', name: 'demo.html', relative_path: 'demos/demo.html' }, documentRelativePath: 'docs/guide.md', documentEpoch: 3, documentId: 'pane document', popoutInstanceId: 'popout-instance:3', requestId: 9 },
    { asset: { kind: 'html', name: 'demo.html', relative_path: 'demos/demo.html' }, documentRelativePath: 'docs/guide.md', documentEpoch: 3, documentId: 'pane-document:3', popoutInstanceId: 'invalid instance', requestId: 9 },
    { asset: { kind: 'html', name: 'demo.html', relative_path: 'demos/demo.html' }, documentRelativePath: 'docs/guide.md', documentEpoch: 3, documentId: 'pane-document:3', popoutInstanceId: 'popout-instance:3', requestId: 0 },
    { asset: { kind: 'html', name: 'demo.html', relative_path: 'demos/demo.html' }, documentRelativePath: 'docs/guide.md', documentEpoch: 3, documentId: 'pane-document:3', popoutInstanceId: 'popout-instance:3', markdown: '[unsafe](https://example.test)', requestId: 9 },
    { asset: { kind: 'html', name: 'demo.html', relative_path: 'demos/demo.html' }, documentRelativePath: 'docs/guide.md', documentEpoch: 3, documentId: 'pane-document:3', requestId: 9 },
  ])('rejects malformed insertion events', (value) => {
    expect(decodeMarkdownMediaCursorInsertion(value)).toBeNull();
  });
});
