// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CrashDraftCatalog } from '../lib/crashDrafts';
import { CrashDraftRecoveryDialog } from './CrashDraftRecoveryDialog';

const catalog: CrashDraftCatalog = {
  schemaVersion: 1,
  catalogToken: 'a'.repeat(64),
  totalBytes: 300,
  limits: { maxDraftBytes: 1024, maxDrafts: 8, maxStoreBytes: 8192 },
  entries: [
    {
      status: 'recoverable', documentId: '1'.repeat(32), draftRevision: 2,
      updatedAtUnixMs: 1_800_000_000_000, contentBytes: 100, pathHint: '/Users/me/private.md',
      baseVersionToken: 'b'.repeat(64), fileKind: 'markdown', entryToken: 'c'.repeat(64),
    },
    {
      status: 'corrupt', documentId: '2'.repeat(32), rawBytes: 100,
      reason: 'checksumMismatch', entryToken: 'd'.repeat(64),
    },
    {
      status: 'unsupportedVersion', documentId: '3'.repeat(32), rawBytes: 100,
      schemaVersion: 2, entryToken: 'e'.repeat(64),
    },
  ],
};

describe('CrashDraftRecoveryDialog', () => {
  it('renders a blocking modal with recovery only for valid recoverable entries', () => {
    const html = renderToStaticMarkup(
      <CrashDraftRecoveryDialog
        busy={false}
        catalog={catalog}
        locale="en"
        onRecover={vi.fn<() => void>()}
        onDiscard={vi.fn<() => void>()}
        onDiscardAll={vi.fn<() => void>()}
      />,
    );
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('mdx found edits');
    expect(html).toContain('newer mdx version');
    expect(html.match(/>Recover</g)).toHaveLength(1);
    expect(html.match(/>Discard</g)).toHaveLength(3);
    expect(html).toContain('Discard All');
    expect(html).not.toContain('/Users/me/private.md');
    expect(html).not.toContain('checksumMismatch');
    expect(html).not.toContain('schemaVersion');
  });

  it('disables every action while busy and always has focusable actions when not busy', () => {
    const busyHtml = renderToStaticMarkup(
      <CrashDraftRecoveryDialog
        busy
        catalog={catalog}
        locale="zh-CN"
        onRecover={vi.fn<() => void>()}
        onDiscard={vi.fn<() => void>()}
        onDiscardAll={vi.fn<() => void>()}
      />,
    );
    expect(busyHtml.match(/disabled=""/g)).toHaveLength(5);
    expect(busyHtml).not.toContain('/Users/me/private.md');

    const activeHtml = renderToStaticMarkup(
      <CrashDraftRecoveryDialog
        busy={false}
        catalog={catalog}
        locale="en"
        onRecover={vi.fn<() => void>()}
        onDiscard={vi.fn<() => void>()}
        onDiscardAll={vi.fn<() => void>()}
      />,
    );
    expect(activeHtml.match(/<button/g)).toHaveLength(5);
    expect(activeHtml).not.toContain('disabled=""');
  });

  it('returns null for an empty valid catalog', () => {
    const html = renderToStaticMarkup(
      <CrashDraftRecoveryDialog
        busy={false}
        catalog={{ ...catalog, entries: [], totalBytes: 0 }}
        locale="en"
        onRecover={vi.fn<() => void>()}
        onDiscard={vi.fn<() => void>()}
        onDiscardAll={vi.fn<() => void>()}
      />,
    );
    expect(html).toBe('');
  });

  it('routes modal actions with exact entry and catalog tokens', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onRecover = vi.fn<(entry: CrashDraftCatalog['entries'][number]) => void>();
    const onDiscard = vi.fn<(entry: CrashDraftCatalog['entries'][number]) => void>();
    const onDiscardAll = vi.fn<(token: string) => void>();

    await act(async () => root.render(
      <CrashDraftRecoveryDialog
        busy={false}
        catalog={catalog}
        locale="en"
        onRecover={onRecover}
        onDiscard={onDiscard}
        onDiscardAll={onDiscardAll}
      />,
    ));
    const buttons = [...container.querySelectorAll('button')];
    act(() => buttons.find((button) => button.textContent === 'Recover')?.click());
    act(() => buttons.find((button) => button.textContent === 'Discard')?.click());
    act(() => buttons.find((button) => button.textContent?.includes('Discard All'))?.click());

    expect(onRecover).toHaveBeenCalledWith(catalog.entries[0]);
    expect(onDiscard).toHaveBeenCalledWith(catalog.entries[0]);
    expect(onDiscardAll).toHaveBeenCalledWith(catalog.catalogToken);
    act(() => root.unmount());
    container.remove();
  });
});
