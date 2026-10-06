import { Download, X } from 'lucide-react';
import type { ExportPreflightIssue } from '../../lib/exportPreflight';
import type { ExportThemeChoice } from '../../lib/offlineHtmlExport';

type ExportFormat = 'html' | 'png' | 'excalidraw';

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
        <ExportDialogFields canExportExcalidraw={canExportExcalidraw} value={value} onChange={onChange} zh={zh} />
        <ExportPreflightSection issues={issues} zh={zh} />
        <div className="settings-dialog-actions">
          <button type="button" className="dialog-button ghost" disabled={busy} onClick={onCancel}>{zh ? '取消' : 'Cancel'}</button>
          <ExportConfirmButton busy={busy} disabled={issues.length > 0} onExport={onExport} zh={zh} />
        </div>
      </dialog>
    </div>
  );
}

// 格式选择器。
function ExportFormatField(props: {
  canExportExcalidraw: boolean;
  onChange: (value: ExportDialogValue) => void;
  value: ExportDialogValue;
  zh: boolean;
}) {
  return (
    <label className="settings-field"><span>{props.zh ? '格式' : 'Format'}</span><select name="exportFormat" value={props.value.format} onChange={(event) => props.onChange({ ...props.value, format: event.target.value as ExportFormat })}><option value="html">{props.zh ? '离线单文件 HTML' : 'Offline single-file HTML'}</option><option value="png">{props.zh ? '高清长图 PNG' : 'Long PNG image'}</option>{props.canExportExcalidraw && <option value="excalidraw">{props.zh ? 'Excalidraw 三件套' : 'Excalidraw bundle'}</option>}</select></label>
  );
}

// 主题选择器。
function ExportThemeField(props: {
  onChange: (value: ExportDialogValue) => void;
  value: ExportDialogValue;
  zh: boolean;
}) {
  return (
    <label className="settings-field"><span>{props.zh ? '主题' : 'Theme'}</span><select name="exportTheme" value={props.value.theme} onChange={(event) => props.onChange({ ...props.value, theme: event.target.value as ExportThemeChoice })}><option value="current">{props.zh ? '当前主题' : 'Current theme'}</option><option value="light">{props.zh ? '亮色' : 'Light'}</option><option value="dark">{props.zh ? '暗色' : 'Dark'}</option></select></label>
  );
}

// 缩放选择器：仅 PNG 与 Excalidraw 需要。
function ExportScaleField(props: {
  onChange: (value: ExportDialogValue) => void;
  value: ExportDialogValue;
  zh: boolean;
}) {
  return (
    <label className="settings-field"><span>{props.zh ? '缩放' : 'Scale'}</span><select name="exportScale" value={props.value.scale} onChange={(event) => props.onChange({ ...props.value, scale: Number(event.target.value) as 1 | 2 | 3 })}><option value="1">1x</option><option value="2">2x</option><option value="3">3x</option></select></label>
  );
}

// 格式/主题/缩放三个选择器。
function ExportDialogFields(props: {
  canExportExcalidraw: boolean;
  onChange: (value: ExportDialogValue) => void;
  value: ExportDialogValue;
  zh: boolean;
}) {
  const scaled = props.value.format === 'png' || props.value.format === 'excalidraw';
  return (
    <section className="settings-section">
      <ExportFormatField canExportExcalidraw={props.canExportExcalidraw} onChange={props.onChange} value={props.value} zh={props.zh} />
      <ExportThemeField onChange={props.onChange} value={props.value} zh={props.zh} />
      {scaled && <ExportScaleField onChange={props.onChange} value={props.value} zh={props.zh} />}
    </section>
  );
}

// 导出前检查清单。
function ExportPreflightSection(props: { issues: readonly ExportPreflightIssue[]; zh: boolean }) {
  return (
    <section className="settings-section export-preflight" aria-live="polite">
      <h3>{props.zh ? '导出前检查' : 'Preflight'}</h3>
      {props.issues.length === 0 ? <p>{props.zh ? '未发现阻止导出的问题。' : 'No blocking export issues were found.'}</p> : <ul>{props.issues.map((issue, index) => <li key={`${issue.kind}-${index}`}>{issue.message}{issue.detail ? ` ${issue.detail}` : ''}</li>)}</ul>}
    </section>
  );
}

// 确认导出按钮：忙态或存在阻断问题时禁用。
function ExportConfirmButton(props: { busy: boolean; disabled: boolean; onExport: () => void; zh: boolean }) {
  return (
    <button type="button" className="dialog-button secondary" disabled={props.busy || props.disabled} onClick={props.onExport}>
      <Download size={14} aria-hidden="true" />{props.busy ? (props.zh ? '导出中' : 'Exporting') : (props.zh ? '导出' : 'Export')}
    </button>
  );
}
