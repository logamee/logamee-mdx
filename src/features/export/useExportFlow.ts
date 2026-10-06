/* eslint-disable react-hooks/exhaustive-deps -- 纯搬移：依赖数组保持提取前原样，由 App.pdf 导出回归约束 */
import { useCallback, useState } from 'react';

import type { ExportDialogValue } from './ExportDialog';
import type { ExportPreflightIssue } from '../../lib/exportPreflight';
import type { SkinId, ThemeAppearance } from '../../lib/theme';
import { normalizeAppError } from '../../lib/appFeedback';
import {
  collectPreviewExportIssues,
  exportBaseName,
  nextExportFormat,
  resolveExportTheme,
  runExcalidrawBundleExport,
  runHtmlExport,
  runPngExport,
} from './exportFlowRunners';

export interface ExportFlowDeps {
  activeFileKind: import('../../types').WorkspaceFileKind;
  activePath: string | null;
  appearance: ThemeAppearance;
  content: string;
  locale: import('../../lib/locale').EffectiveLocale;
  getPreviewPaneEl: () => HTMLElement | null;
  setError: (error: string | null) => void;
  setNotice: (notice: string | null) => void;
  skin: SkinId;
}

export function useExportFlow(deps: ExportFlowDeps) {
  const { activeFileKind, activePath, appearance, content, locale, getPreviewPaneEl, setError, setNotice, skin } = deps;
      const [showExport, setShowExport] = useState(false);
    const [exportBusy, setExportBusy] = useState(false);
    const [exportValue, setExportValue] = useState<ExportDialogValue>({ format: 'html', scale: 2, theme: 'current' });
    const [exportIssues, setExportIssues] = useState<ExportPreflightIssue[]>([]);

  const openExportDialog = useCallback(() => {
    if (activeFileKind !== 'markdown' && activeFileKind !== 'excalidraw') return;
    setExportIssues(collectPreviewExportIssues(getPreviewPaneEl, content));
    setExportValue((current) => ({ ...current, format: nextExportFormat(activeFileKind, current.format) }));
    setShowExport(true);
  }, [activeFileKind, content, getPreviewPaneEl]);


  const runExport = useCallback(async () => {
    setExportBusy(true);
    try {
      const baseName = exportBaseName(activePath);
      const { appearance: appearanceForExport, skin: skinForExport } = resolveExportTheme({
        appearance, selectedTheme: exportValue.theme, skin,
      });
      let saved: boolean;
      if (exportValue.format === 'excalidraw') {
        if (activeFileKind !== 'excalidraw') throw new Error('Excalidraw bundle export requires an Excalidraw document');
        saved = await runExcalidrawBundleExport({ appearance: appearanceForExport, baseName, content });
      } else {
        const preview = getPreviewPaneEl()?.querySelector<HTMLElement>('.mmd-preview-content');
        if (!preview) throw new Error('Export preview is unavailable');
        const shared = { appearance: appearanceForExport, baseName, locale, preview, skin: skinForExport };
        saved = exportValue.format === 'html'
          ? await runHtmlExport(shared)
          : await runPngExport({ ...shared, scale: exportValue.scale });
      }
      if (!saved) return;
      setShowExport(false);
      setError(null);
      setNotice(locale === 'zh-CN' ? '导出已完成。' : 'Export completed.');
    } catch (exportError) {
      setShowExport(false);
      setError(normalizeAppError(exportError, locale));
      setNotice(null);
    } finally {
      setExportBusy(false);
    }
  }, [activeFileKind, activePath, appearance, content, exportValue, locale, getPreviewPaneEl, setError, setNotice, skin]);

  return { showExport, setShowExport, exportBusy, exportValue, setExportValue, exportIssues, setExportIssues, openExportDialog, runExport };
}

