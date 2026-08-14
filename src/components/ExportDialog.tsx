import { Download, X } from 'lucide-react';
import type { ExportPreflightIssue } from '../lib/exportPreflight';
import type { ExportThemeChoice } from '../lib/offlineHtmlExport';

export type ExportFormat = 'html' | 'png' | 'excalidraw';

export interface ExportDialogValue {
  format: ExportFormat;
  theme: ExportThemeChoice;
  scale: 1 | 2 | 3;
}

interface ExportDialogProps {
  busy: boolean;
  canExportExcalidraw: boolean;
  issues: readonly ExportPreflightIssue[];
  locale: 'en' | 'zh-CN';
  value: ExportDialogValue;
  onCancel: () => void;
  onChange: (value: ExportDialogValue) => void;
  onExport: () => void;
}

export function ExportDialog({ busy, canExportExcalidraw, issues, locale, value, onCancel, onChange, onExport }: ExportDialogProps) {
  const zh = locale === 'zh-CN';
  return (
    <div className="settings-dialog-backdrop">
      <dialog open className="settings-dialog export-dialog" aria-modal="true" aria-labelledby="export-dialog-title">
        <header className="settings-dialog-header">
          <div className="settings-dialog-heading"><Download size={18} aria-hidden="true" /><h2 id="export-dialog-title">{zh ? '导出' : 'Export'}</h2></div>
          <button type="button" className="settings-dialog-close" aria-label={zh ? '取消' : 'Cancel'} title={zh ? '取消' : 'Cancel'} onClick={onCancel}><X size={17} /></button>
        </header>
        <section className="settings-section">
          <label className="settings-field"><span>{zh ? '格式' : 'Format'}</span><select name="exportFormat" value={value.format} onChange={(event) => onChange({ ...value, format: event.target.value as ExportFormat })}><option value="html">{zh ? '离线单文件 HTML' : 'Offline single-file HTML'}</option><option value="png">{zh ? '高清长图 PNG' : 'Long PNG image'}</option>{canExportExcalidraw && <option value="excalidraw">{zh ? 'Excalidraw 三件套' : 'Excalidraw bundle'}</option>}</select></label>
          <label className="settings-field"><span>{zh ? '主题' : 'Theme'}</span><select name="exportTheme" value={value.theme} onChange={(event) => onChange({ ...value, theme: event.target.value as ExportThemeChoice })}><option value="current">{zh ? '当前主题' : 'Current theme'}</option><option value="light">{zh ? '亮色' : 'Light'}</option><option value="dark">{zh ? '暗色' : 'Dark'}</option></select></label>
          {(value.format === 'png' || value.format === 'excalidraw') && <label className="settings-field"><span>{zh ? '缩放' : 'Scale'}</span><select name="exportScale" value={value.scale} onChange={(event) => onChange({ ...value, scale: Number(event.target.value) as 1 | 2 | 3 })}><option value="1">1x</option><option value="2">2x</option><option value="3">3x</option></select></label>}
        </section>
        <section className="settings-section export-preflight" aria-live="polite">
          <h3>{zh ? '导出前检查' : 'Preflight'}</h3>
          {issues.length === 0 ? <p>{zh ? '未发现阻止导出的问题。' : 'No blocking export issues were found.'}</p> : <ul>{issues.map((issue, index) => <li key={`${issue.kind}-${index}`}>{issue.message}{issue.detail ? ` ${issue.detail}` : ''}</li>)}</ul>}
        </section>
        <div className="settings-dialog-actions">
          <button type="button" className="dialog-button ghost" disabled={busy} onClick={onCancel}>{zh ? '取消' : 'Cancel'}</button>
          <button type="button" className="dialog-button secondary" disabled={busy || issues.length > 0} onClick={onExport}><Download size={14} aria-hidden="true" />{busy ? (zh ? '导出中' : 'Exporting') : (zh ? '导出' : 'Export')}</button>
        </div>
      </dialog>
    </div>
  );
}

