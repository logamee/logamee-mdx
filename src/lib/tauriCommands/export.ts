import { invoke } from '@tauri-apps/api/core';

// 导出命令。

type ExportKind = 'html' | 'png';

export interface SaveExportInput {
  kind: ExportKind;
  defaultName: string;
  bytesBase64: string;
}

export interface SaveExportResponse {
  path: string;
  bytesWritten: number;
}

export interface SaveExcalidrawBundleInput {
  baseName: string;
  source: string;
  svgBase64: string;
  png1xBase64: string;
  png2xBase64: string;
  png3xBase64: string;
}

function decodeSaveExportResponse(value: unknown): SaveExportResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid export response');
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2
    || typeof record.path !== 'string'
    || record.path.length === 0
    || typeof record.bytesWritten !== 'number'
    || !Number.isSafeInteger(record.bytesWritten)
    || record.bytesWritten <= 0
  ) throw new Error('Invalid export response');
  return { path: record.path, bytesWritten: record.bytesWritten };
}

export async function saveExport(input: SaveExportInput): Promise<SaveExportResponse | null> {
  const response = await invoke<unknown>('save_export_dialog', { input });
  return response === null ? null : decodeSaveExportResponse(response);
}

export async function saveExcalidrawBundle(input: SaveExcalidrawBundleInput): Promise<string[] | null> {
  const response = await invoke<unknown>('save_excalidraw_bundle_dialog', { input });
  if (response === null) return null;
  if (!Array.isArray(response) || response.length !== 5 || response.some((path) => typeof path !== 'string' || path.length === 0)) {
    throw new Error('Invalid Excalidraw bundle response');
  }
  return response as string[];
}
