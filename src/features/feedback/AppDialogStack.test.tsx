// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { domAnimation, LazyMotion } from 'motion/react';
import { getUnsavedExitPrompt, getUnsavedFileSwitchPrompt } from '../../lib/closeGuard';
import { currentSettingsEnvelope } from '../../lib/settingsFixtures';
import { rebuildWorkspaceIndex } from '../../lib/tauriCommands';
import { AppDialogStackSection } from './AppDialogStack';
import type { AppDialogStackComposites } from './appDialogStackComposites';

vi.mock('../../lib/tauriCommands', () => ({
  rebuildWorkspaceIndex: vi.fn<typeof import('../../lib/tauriCommands').rebuildWorkspaceIndex>(() => new Promise(() => {})),
  cancelWorkspaceIndexOperation: vi.fn<typeof import('../../lib/tauriCommands').cancelWorkspaceIndexOperation>(async () => true),
}));

function idleDialogs(): AppDialogStackComposites {
  const noop = () => undefined;
  const done = async () => undefined;
  return {
    appUpdater: { update: null, installing: false, later: noop, skip: noop, install: done },
    crashDraftRecovery: { busy: false, canRepairOverflow: false, error: null, overflowRepairProgress: null, retry: done, repairOverflowBatch: done },
    dismissFeedbackDialog: noop, feedbackDialog: null, locale: 'en',
    exportFlow: { exportBusy: false, exportIssues: [], exportValue: { format: 'html', theme: 'current', scale: 1 }, openExportDialog: noop, runExport: done, setExportValue: noop, setShowExport: noop, showExport: false },
    intentDirtyModal: { handleCancelFileSwitch: noop, handleFileSwitchWithoutSaving: noop, handleSaveAndSwitchFile: done },
    panels: {
      search: { discardCurrentWorkspaceIndex: noop, rebuildCurrentWorkspaceIndex: noop, requestWorkspaceSearchOpen: noop, setWorkspaceSearchMode: noop, workspaceIndexActionBusy: false },
      tree: { handleWorkspaceEntryConfirm: noop, handleWorkspaceMoveConfirm: noop, setWorkspaceEntryOperation: noop, setWorkspaceMoveOperation: noop },
    },
    session: {
      activeFileKind: 'markdown', busy: false, externalFileAction: null, saveConflict: null, workspaceRoot: null, workspaceToken: null,
      handleCancelSaveConflict: noop, handleCloseDeletedDraft: done, handleKeepCurrentExternal: done, handleOverwriteSaveConflict: done,
      handleSaveDeletedDraftAs: done, handleUseExternal: done, setError: noop, setNotice: noop,
    },
    settingsState: { busy: false, recovery: null, reset: done, retry: done, settings: currentSettingsEnvelope.settings, updateSettings: done },
    setShowSettings: noop, showSettings: false,
    uiStates: { setWorkspaceSearchMode: noop, workspaceEntryOperation: null, workspaceIndexActionBusy: false, workspaceMoveOperation: null, workspaceSearchMode: null },
    unsavedExit: { handleCancelExit: noop, handleQuitWithoutSaving: noop, handleSaveAndQuit: noop, showUnsavedExitPrompt: false, unsavedExitPrompt: null, unsavedFileSwitchPrompt: null },
    workspaceMoveDestinations: [], handleAuthorizeResourceDirectory: async () => null,
  };
}

const feedback = { kind: 'info', role: 'dialog', dismissLabel: 'OK', title: 'Saved', message: 'Settings saved' } as const;

const dialogRoutes: [string, (ctx: AppDialogStackComposites) => void][] = [
  ['export-dialog-title', ctx => { ctx.exportFlow.showExport = true; }],
  ['crash-draft-store-repair-title', ctx => { ctx.crashDraftRecovery.error = { code: 'storeFull', message: 'Storage full', canReset: false }; }],
  ['settings-recovery-title', ctx => { ctx.settingsState.recovery = { kind: 'conflict', canReset: false }; }],
  ['external-file-change-title', ctx => { ctx.session.externalFileAction = { kind: 'conflict', path: '/note.md', busy: false }; }],
  ['document-save-conflict-title', ctx => { ctx.session.saveConflict = { path: '/note.md', busy: false }; }],
  ['unsaved-exit-title', ctx => { ctx.unsavedExit.showUnsavedExitPrompt = true; ctx.unsavedExit.unsavedExitPrompt = getUnsavedExitPrompt('/note.md', 'en'); }],
  ['workspace-entry-dialog-title', ctx => { ctx.uiStates.workspaceEntryOperation = { kind: 'create-folder', parentName: 'Notes', parentPath: '/notes' }; }],
  ['workspace-move-dialog-title', ctx => { ctx.uiStates.workspaceMoveOperation = { currentName: 'Note', entryKind: 'file', path: '/note.md' }; }],
  ['settings-dialog-title', ctx => { ctx.showSettings = true; }],
  ['update-dialog-title', ctx => { ctx.appUpdater.update = { currentVersion: '1.0.0', version: '1.1.0', close: async () => undefined, downloadAndInstall: async () => undefined }; }],
];

describe('application dialog stack', () => {
  let container: HTMLDivElement;
  let root: Root;
  let ctx: AppDialogStackComposites;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    ctx = idleDialogs();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  const render = () => act(() => root.render(<LazyMotion features={domAnimation}><AppDialogStackSection ctx={ctx} /></LazyMotion>));
  const click = (label: string) => {
    const button = [...container.querySelectorAll('button')].find(candidate => candidate.textContent === label);
    expect(button).toBeDefined();
    act(() => button!.click());
  };

  it.each(dialogRoutes)('prioritizes %s over a pending notification', (title, open) => {
    ctx.feedbackDialog = feedback;
    open(ctx);
    render();
    const modals = container.querySelectorAll('[aria-modal="true"]');
    expect(modals).toHaveLength(1);
    expect(modals[0].getAttribute('aria-labelledby')).toBe(title);
  });

  it('routes a file switch confirmation to the switch flow', () => {
    const saveAndSwitch = vi.fn<() => Promise<void>>(async () => undefined);
    ctx.unsavedExit.unsavedFileSwitchPrompt = getUnsavedFileSwitchPrompt('/note.md', '/next.md', 'en');
    ctx.intentDirtyModal.handleSaveAndSwitchFile = saveAndSwitch;
    render();
    expect(container.textContent).toContain('next.md');
    click(ctx.unsavedExit.unsavedFileSwitchPrompt.saveLabel);
    expect(saveAndSwitch).toHaveBeenCalledOnce();
  });

  it.each(['quick-open', 'workspace-search'] as const)('requires workspace authority for %s and closes on Escape', mode => {
    const close = vi.fn<AppDialogStackComposites['uiStates']['setWorkspaceSearchMode']>();
    ctx.panels.search.setWorkspaceSearchMode = close;
    ctx.uiStates.workspaceSearchMode = mode;
    ctx.session.workspaceRoot = '/notes';
    render();
    expect(container.querySelector('dialog')).toBeNull();
    ctx.session.workspaceToken = 'token';
    render();
    expect(container.querySelector('#workspace-search-dialog-title')?.textContent).toBe(mode === 'quick-open' ? 'Quick Open' : 'Workspace Search');
    act(() => container.querySelector('dialog')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(close).toHaveBeenCalledWith(null);
  });

  it.each(['search', 'update'])('closes %s and reports a friendly error when its operation fails', async kind => {
    const failure = new Error('private runtime details');
    const close = vi.fn<() => void>();
    ctx.session.setError = vi.fn<typeof ctx.session.setError>();
    ctx.session.setNotice = vi.fn<typeof ctx.session.setNotice>();
    if (kind === 'search') {
      vi.mocked(rebuildWorkspaceIndex).mockRejectedValueOnce(failure);
      ctx.session.workspaceRoot = '/notes';
      ctx.session.workspaceToken = 'token';
      ctx.uiStates.workspaceSearchMode = 'workspace-search';
      ctx.panels.search.setWorkspaceSearchMode = close;
    } else {
      ctx.appUpdater.update = { currentVersion: '1.0.0', version: '1.1.0', close: async () => undefined, downloadAndInstall: async () => undefined };
      ctx.appUpdater.install = vi.fn<typeof ctx.appUpdater.install>().mockRejectedValue(failure);
      ctx.appUpdater.later = close;
    }
    await act(async () => { render(); });
    if (kind === 'update') await act(async () => { click('Update now'); });
    expect(close).toHaveBeenCalledOnce();
    expect(ctx.session.setError).toHaveBeenCalledWith('The operation could not be completed. Please try again.');
    expect(ctx.session.setNotice).toHaveBeenCalledWith(null);
  });

  it.each(['Save', 'Reset Settings'] as const)('closes settings after %s completes', async action => {
    const close = vi.fn<typeof ctx.setShowSettings>();
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const write = vi.fn<() => Promise<void>>(() => pending);
    ctx.setShowSettings = close;
    ctx.showSettings = true;
    if (action === 'Save') ctx.settingsState.updateSettings = write;
    else ctx.settingsState.reset = write;
    render();
    click(action);
    expect(write).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    await act(async () => { finish(); });
    expect(close).toHaveBeenCalledWith(false);
  });

  it('routes the two external-change decisions to distinct document commands', () => {
    ctx.session.externalFileAction = { kind: 'conflict', path: '/note.md', busy: false };
    ctx.session.handleKeepCurrentExternal = vi.fn<typeof ctx.session.handleKeepCurrentExternal>();
    ctx.session.handleUseExternal = vi.fn<typeof ctx.session.handleUseExternal>();
    render();
    click('Use External Version');
    expect(ctx.session.handleUseExternal).toHaveBeenCalledOnce();
    expect(ctx.session.handleKeepCurrentExternal).not.toHaveBeenCalled();
    click('Overwrite with Current Edits');
    expect(ctx.session.handleKeepCurrentExternal).toHaveBeenCalledOnce();
    expect(ctx.session.handleUseExternal).toHaveBeenCalledOnce();
  });

  it('keeps the exiting notification inert until recovery can take its place', async () => {
    Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: () => undefined });
    try {
      ctx.feedbackDialog = feedback;
      render();
      expect(container.querySelector('#app-feedback-title')).not.toBeNull();
      ctx.settingsState.recovery = { kind: 'recoverable', canReset: true };
      render();
      expect(container.querySelectorAll('[aria-modal="true"]')).toHaveLength(1);
      expect(container.querySelector('#app-feedback-title')?.closest('[inert]')).not.toBeNull();
      expect(container.querySelector('#settings-recovery-title')).toBeNull();
      await vi.waitFor(async () => {
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
        expect(container.querySelector('#settings-recovery-title')).not.toBeNull();
      });
      expect(container.querySelectorAll('[aria-modal="true"]')).toHaveLength(1);
    } finally {
      Reflect.deleteProperty(Element.prototype, 'animate');
    }
  });
});
