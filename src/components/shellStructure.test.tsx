// @ts-expect-error Vitest executes this contract in Node; the app tsconfig excludes Node globals.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FileSidebar } from './FileSidebar';
import { EditorPane } from './EditorPane';
import { PaneResizer } from './PaneResizer';
import { PaneHeader } from './PaneHeader';
import { AppToolbar } from './AppToolbar';
import { WorkspaceSidebarResizer } from './WorkspaceSidebarResizer';
import { getPanePopoutButtonState } from '../lib/paneLayout';

const appShellCss = readFileSync(new URL('../styles/app-shell.css', import.meta.url), 'utf8');
const responsiveCss = readFileSync(new URL('../styles/responsive.css', import.meta.url), 'utf8');

describe('shell structure accessibility', () => {
  it('keeps file actions out of the web toolbar because they live in the native system menu bar', () => {
    const html = renderToStaticMarkup(
      <AppToolbar
        activePath="/workspace/notes/design.md"
        busy={false}
        canSearch
        dirty={false}
        onQuickOpen={vi.fn<() => void>()}
        onWorkspaceSearch={vi.fn<() => void>()}
      />,
    );

    expect(html).toContain('mdx');
    expect(html).toContain('aria-label="Current document"');
    expect(html).toContain('title="/workspace/notes/design.md"');
    expect(html).toContain('design.md');
    expect(html).toContain('Saved');
    expect(html).not.toContain('aria-label="File actions"');
    expect(html).not.toContain('role="menu"');
    expect(html).not.toContain('New');
    expect(html).not.toContain('Open File');
    expect(html).not.toContain('Open Directory');
    expect(html).not.toContain('Save As');
    expect(html).not.toContain('class="toolbar-actions"');
  });

  it('provides non-translucent and high-contrast shell fallbacks', () => {
    expect(appShellCss).toContain('@media (prefers-reduced-transparency: reduce)');
    expect(appShellCss).toContain('@media (prefers-contrast: more)');
    expect(appShellCss).toMatch(/prefers-reduced-transparency:[\s\S]*?backdrop-filter:\s*none/);
    expect(appShellCss).toMatch(/prefers-contrast:[\s\S]*?border-color:\s*var\(--chrome-text\)/);
  });

  it('positions the workspace add menu in the viewport with an end-aligned origin', () => {
    expect(appShellCss).toMatch(
      /\.sidebar-add-menu\s*\{[^}]*position:\s*fixed;[^}]*transform-origin:\s*top right;/,
    );
  });

  it('protects file tree role and collapse labels', () => {
    const html = renderToStaticMarkup(
      <FileSidebar
        activePath="/workspace/notes/a.md"
        collapsed={false}
        collapsedFolders={new Set()}
        fileTree={[{ absolutePath: '/workspace/notes', kind: 'folder', name: 'notes', path: 'notes', children: [{ absolutePath: '/workspace/notes/a.md', kind: 'file', name: 'a.md', path: '/workspace/notes/a.md', relativePath: 'notes/a.md', file: { kind: 'markdown', path: '/workspace/notes/a.md', relative_path: 'notes/a.md', name: 'a.md' } }] }]}
        onCollapseChange={vi.fn<() => void>()}
        onOpenFile={vi.fn<() => void>()}
        onCreateFile={vi.fn<() => void>()}
        onCreateFolder={vi.fn<() => void>()}
        onDeleteEntry={vi.fn<() => void>()}
        onMoveEntry={vi.fn<() => void>()}
        onRefreshWorkspace={vi.fn<() => void>()}
        onRenameEntry={vi.fn<() => void>()}
        onRequestMove={vi.fn<() => void>()}
        onToggleFolder={vi.fn<() => void>()}
        workspaceRoot="/workspace"
      />,
    );

    expect(html).toContain('role="tree"');
    expect(html).toContain('aria-label="Workspace file tree"');
    expect(html).toContain('role="treeitem"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('Workspace files');
    expect(html).not.toContain('Markdown files');
    expect(html).not.toContain('class="tree-count"');
    expect(html).toContain('data-context-menu-target="workspace-root"');
    expect(html).toContain('data-context-menu-target="folder"');
    expect(html).toContain('data-context-menu-target="file"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).not.toContain('aria-label="New file in workspace root"');
    expect(html).not.toContain('aria-label="New folder in workspace root"');
    expect(html).not.toContain('aria-label="New file in notes"');
    expect(html).not.toContain('aria-label="Rename a.md"');
    expect(html).not.toContain('aria-label="Delete a.md"');
    expect(html).toContain('/workspace');
  });

  it('uses an image icon for previewable image files', () => {
    const html = renderToStaticMarkup(
      <FileSidebar
        activePath={null}
        collapsed={false}
        collapsedFolders={new Set()}
        fileTree={[{ absolutePath: '/workspace/cover.png', kind: 'file', name: 'cover.png', path: '/workspace/cover.png', relativePath: 'cover.png', file: { kind: 'image', path: '/workspace/cover.png', relative_path: 'cover.png', name: 'cover.png' } }]}
        onCollapseChange={vi.fn<() => void>()}
        onOpenFile={vi.fn<() => void>()}
        onCreateFile={vi.fn<() => void>()}
        onCreateFolder={vi.fn<() => void>()}
        onDeleteEntry={vi.fn<() => void>()}
        onMoveEntry={vi.fn<() => void>()}
        onRefreshWorkspace={vi.fn<() => void>()}
        onRenameEntry={vi.fn<() => void>()}
        onRequestMove={vi.fn<() => void>()}
        onToggleFolder={vi.fn<() => void>()}
        workspaceRoot="/workspace"
      />,
    );

    expect(html).toContain('class="lucide lucide-image tree-icon image-icon"');
    expect(html).not.toContain('class="lucide lucide-file-text tree-icon file-icon"');
  });

  it('uses distinct icons for HTML, video, and audio files', () => {
    const html = renderToStaticMarkup(
      <FileSidebar
        activePath={null}
        collapsed={false}
        collapsedFolders={new Set()}
        fileTree={[
          { absolutePath: '/workspace/index.html', kind: 'file', name: 'index.html', path: '/workspace/index.html', relativePath: 'index.html', file: { kind: 'html', path: '/workspace/index.html', relative_path: 'index.html', name: 'index.html' } },
          { absolutePath: '/workspace/clip.mp4', kind: 'file', name: 'clip.mp4', path: '/workspace/clip.mp4', relativePath: 'clip.mp4', file: { kind: 'video', path: '/workspace/clip.mp4', relative_path: 'clip.mp4', name: 'clip.mp4' } },
          { absolutePath: '/workspace/song.mp3', kind: 'file', name: 'song.mp3', path: '/workspace/song.mp3', relativePath: 'song.mp3', file: { kind: 'audio', path: '/workspace/song.mp3', relative_path: 'song.mp3', name: 'song.mp3' } },
        ]}
        onCollapseChange={vi.fn<() => void>()}
        onOpenFile={vi.fn<() => void>()}
        onCreateFile={vi.fn<() => void>()}
        onCreateFolder={vi.fn<() => void>()}
        onDeleteEntry={vi.fn<() => void>()}
        onMoveEntry={vi.fn<() => void>()}
        onRefreshWorkspace={vi.fn<() => void>()}
        onRenameEntry={vi.fn<() => void>()}
        onRequestMove={vi.fn<() => void>()}
        onToggleFolder={vi.fn<() => void>()}
        workspaceRoot="/workspace"
      />,
    );

    expect(html).toContain('tree-icon html-icon');
    expect(html).toContain('tree-icon video-icon');
    expect(html).toContain('tree-icon audio-icon');
  });

  it('labels the HTML source editor by its actual document type', () => {
    const html = renderToStaticMarkup(
      <EditorPane activePath="/workspace/index.html" content="<h1>Home</h1>" documentEpoch={1} documentId="document-html" fileKind="html" onContentChange={vi.fn<() => void>()} />,
    );

    expect(html).toContain('aria-label="HTML source editor"');
  });

  it('keeps editor status readable when an editor pane is narrow', () => {
    const html = renderToStaticMarkup(
      <EditorPane activePath="/workspace/draft.md" content="# Draft" documentEpoch={1} documentId="document-draft" onContentChange={vi.fn<() => void>()} />,
    );

    expect(html).toContain('aria-label="Editor status"');
    expect(html).toContain('editor-status-stat');
    expect(html).toContain('editor-status-characters');
    expect(appShellCss).toContain('container-name: editor-pane;');
    expect(appShellCss).toContain('@container editor-pane (max-width: 420px)');
    expect(appShellCss).toContain('@container editor-pane (max-width: 280px)');
    expect(appShellCss).toContain('.editor-status-stat { flex: 0 0 auto; }');
    expect(appShellCss).toContain('flex: 1 1 auto;');
    expect(appShellCss).toMatch(/\.editor-status\s*\{[\s\S]*?overflow: hidden;/);
    expect(appShellCss).toMatch(/@container editor-pane \(max-width: 280px\)[\s\S]*?\.editor-status-stat\s*\{\s*display: none;/);
  });

  it('removes the inactive workspace tab panel from layout', () => {
    expect(appShellCss).toMatch(/\.sidebar-panel\[hidden\]\s*\{\s*display:\s*none;/);
  });

  it('protects editor aria label and pane popout button state', () => {
    const html = renderToStaticMarkup(
      <EditorPane
        activePath="/workspace/draft.md"
        content="# Draft"
        documentEpoch={1}
        documentId="document-draft"
        paneRef={() => undefined}
        popoutButton={getPanePopoutButtonState('editor', true)}
        onContentChange={vi.fn<() => void>()}
        onPopout={vi.fn<() => void>()}
      />,
    );

    expect(html).toContain('aria-label="Markdown source editor"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('Editor is open in a separate window; click to focus it');
    expect(html).toContain('Popped out');
  });

  it('protects pane header and resizer accessible values', () => {
    const headerHtml = renderToStaticMarkup(
      <PaneHeader title="Live Preview" subtitle="synced" popoutButton={getPanePopoutButtonState('preview', false)} onPopout={vi.fn<() => void>()} />,
    );
    const resizerHtml = renderToStaticMarkup(
      <PaneResizer editorPaneRatio={0.5} onKeyDown={vi.fn<() => void>()} onPointerCancel={vi.fn<() => void>()} onPointerDown={vi.fn<() => void>()} onPointerMove={vi.fn<() => void>()} onPointerUp={vi.fn<() => void>()} />,
    );

    expect(headerHtml).toContain('Live Preview');
    expect(headerHtml).toContain('synced');
    expect(headerHtml).toContain('aria-label="Pop out live preview"');
    expect(headerHtml).toContain('aria-pressed="false"');
    expect(resizerHtml).toContain('aria-label="Resize editor and preview panes"');
    expect(resizerHtml).toContain('role="separator"');
    expect(resizerHtml).toContain('aria-orientation="vertical"');
    expect(resizerHtml).toContain('aria-valuemin="25"');
    expect(resizerHtml).toContain('aria-valuemax="75"');
    expect(resizerHtml).toContain('aria-valuenow="50"');
  });

  it('exposes the workspace width resizer as an accessible vertical separator', () => {
    const html = renderToStaticMarkup(
      <WorkspaceSidebarResizer
        sidebarWidth={264}
        onKeyDown={vi.fn<() => void>()}
        onPointerCancel={vi.fn<() => void>()}
        onPointerDown={vi.fn<() => void>()}
        onPointerMove={vi.fn<() => void>()}
        onPointerUp={vi.fn<() => void>()}
      />,
    );

    expect(html).toContain('class="workspace-sidebar-resizer"');
    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-orientation="vertical"');
    expect(html).toContain('aria-label="Resize workspace sidebar"');
    expect(html).toContain('aria-valuemin="180"');
    expect(html).toContain('aria-valuemax="420"');
    expect(html).toContain('aria-valuenow="264"');
    expect(appShellCss).toContain('var(--workspace-sidebar-width, 264px)');
    expect(responsiveCss).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.workspace-sidebar-resizer\s*\{\s*display: none;/);
  });

  it('keeps document previews full-width with stable PDF and DOCX viewports at desktop and narrow sizes', () => {
    expect(appShellCss).toContain('.workspace.document-mode');
    expect(appShellCss).toContain('.workspace.sidebar-collapsed.document-mode');
    expect(appShellCss).toContain('.preview-zoom-toolbar');
    expect(appShellCss).toContain('.pdf-preview-viewport');
    expect(appShellCss).toContain('.pdf-preview-viewport canvas');
    expect(appShellCss).toContain('.docx-preview');
    expect(appShellCss).toContain('.docx-preview-viewport');
    expect(appShellCss).toContain('.docx-preview-document');
    expect(appShellCss).toContain('font-size: var(--docx-zoom, 100%)');
    expect(appShellCss).toContain('.docx-preview-document img');
    expect(appShellCss).toContain('.docx-preview-document table');
    expect(responsiveCss).toContain('.workspace.document-mode > .preview-pane');
    expect(responsiveCss).toContain('.pdf-preview-viewport');
    expect(responsiveCss).toContain('.docx-preview-viewport');
  });

  it('keeps Excalidraw in a single, bounded canvas layout at every workspace width', () => {
    expect(appShellCss).toContain('.workspace.excalidraw-mode');
    expect(appShellCss).toContain('.excalidraw-viewport');
    expect(appShellCss).toContain('.excalidraw-viewport > .excalidraw');
    expect(responsiveCss).toContain(':not(.excalidraw-mode)');
    expect(responsiveCss).toContain('.workspace.excalidraw-mode > .excalidraw-pane');
  });
});
