import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { FileTreeRows } from './FileTreeRows';

describe('FileTreeRows document presentation', () => {
  it('renders distinct PDF, DOCX, and Excalidraw icons and carries file kind into context policy', () => {
    const targets: unknown[] = [];
    type RowsProps = ComponentProps<typeof FileTreeRows>;
    const html = renderToStaticMarkup(
      <FileTreeRows
        activePath={null}
        collapsedFolders={new Set()}
        draggingPath={null}
        dropTargetPath={null}
        nodes={[
          {
            absolutePath: '/workspace/guide.pdf',
            kind: 'file',
            name: 'guide.pdf',
            path: '/workspace/guide.pdf',
            relativePath: 'guide.pdf',
            file: { kind: 'pdf', name: 'guide.pdf', path: '/workspace/guide.pdf', relative_path: 'guide.pdf' },
          },
          {
            absolutePath: '/workspace/report.docx',
            kind: 'file',
            name: 'report.docx',
            path: '/workspace/report.docx',
            relativePath: 'report.docx',
            file: { kind: 'docx', name: 'report.docx', path: '/workspace/report.docx', relative_path: 'report.docx' },
          },
          {
            absolutePath: '/workspace/architecture.excalidraw',
            kind: 'file',
            name: 'architecture.excalidraw',
            path: '/workspace/architecture.excalidraw',
            relativePath: 'architecture.excalidraw',
            file: { kind: 'excalidraw', name: 'architecture.excalidraw', path: '/workspace/architecture.excalidraw', relative_path: 'architecture.excalidraw' },
          },
        ]}
        onBeginRename={vi.fn<RowsProps['onBeginRename']>()}
        onCancelRename={vi.fn<RowsProps['onCancelRename']>()}
        onCommitRename={vi.fn<RowsProps['onCommitRename']>()}
        onDeleteEntry={vi.fn<RowsProps['onDeleteEntry']>()}
        onOpenContextMenu={(_x, _y, target) => targets.push(target)}
        onOpenFile={vi.fn<(path: string) => void>()}
        onSelectTarget={vi.fn<RowsProps['onSelectTarget']>()}
        onToggleFolder={vi.fn<(path: string) => void>()}
        renamingPath={null}
        selectedPath={null}
      />,
    );

    expect(html).toContain('tree-icon pdf-icon');
    expect(html).toContain('tree-icon docx-icon');
    expect(html).toContain('tree-icon excalidraw-icon');
  });
});
