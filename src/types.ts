export type WorkspaceFileKind =
  | 'markdown'
  | 'html'
  | 'excalidraw'
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'docx';
export type ContentMode = 'text' | 'binary';

export interface FileVersion {
  canonicalPath: string;
  platformIdentity: string;
  length: string;
  modifiedNanos: string;
  sha256: string;
}

export interface WorkspaceFileEntry {
  kind: WorkspaceFileKind;
  path: string;
  relative_path: string;
  name: string;
}

export interface WorkspaceDirectoryEntry {
  path: string;
  relative_path: string;
  name: string;
}

export interface OpenMarkdownFileResponse {
  kind: 'markdown';
  path: string;
  content_mode: 'text';
  content: string;
  file_version: FileVersion;
  mime_type?: never;
}

export interface OpenImageFileResponse {
  kind: 'image';
  path: string;
  content_mode: 'binary';
  content?: never;
  file_version?: never;
  mime_type: string;
}

export interface OpenHtmlFileResponse {
  kind: 'html';
  path: string;
  content_mode: 'text';
  content: string;
  file_version: FileVersion;
  mime_type: string;
}

export interface OpenExcalidrawFileResponse {
  kind: 'excalidraw';
  path: string;
  content_mode: 'text';
  content: string;
  file_version: FileVersion;
  mime_type?: never;
}

export interface OpenMediaFileResponse {
  kind: 'video' | 'audio';
  path: string;
  content_mode: 'binary';
  content?: never;
  file_version?: never;
  mime_type: string;
}

export interface OpenBinaryDocumentResponse {
  kind: 'pdf' | 'docx';
  path: string;
  content_mode: 'binary';
  content?: never;
  file_version?: never;
  mime_type: string;
  bytes_base64: string;
}

export type OpenFileResponse =
  | OpenMarkdownFileResponse
  | OpenHtmlFileResponse
  | OpenExcalidrawFileResponse
  | OpenImageFileResponse
  | OpenMediaFileResponse
  | OpenBinaryDocumentResponse;

export type DocumentSaveResponse =
  | {
      status: 'confirmed_committed';
      path: string;
      version: FileVersion;
      cleanup_repair_receipt?: string;
    }
  | {
      status: 'confirmed_not_committed';
      path: string;
      current_version?: FileVersion;
      message: string;
    }
  | {
      status: 'conflict';
      path: string;
      current_version?: FileVersion;
      overwrite_token?: string;
      message: string;
    }
  | {
      status: 'indeterminate';
      path: string;
      message: string;
    };

export interface OverwriteTokenResponse {
  overwriteToken: string;
}

export interface PreparedOpenFileResponse {
  file: OpenFileResponse;
  open_receipt: string;
  commit_operation_id: string;
}

export interface WorkspaceSessionRestore {
  workspace: WorkspaceSnapshot;
  active_file: PreparedOpenFileResponse | null;
}

export interface RecentFileSummary {
  id: string;
  display_name: string;
}

export interface RecentFilesSnapshot {
  entries: RecentFileSummary[];
}

export type OpenCommitResult =
  | { status: 'committed'; recent_files: RecentFilesSnapshot }
  | { status: 'not_committed'; message: string };

export type OpenCommitStatus =
  | { status: 'pending' }
  | { status: 'committed'; recent_files: RecentFilesSnapshot }
  | { status: 'not_committed'; message: string }
  | { status: 'unknown' };

export interface WorkspaceDirectoryListing {
  root: string;
  files: WorkspaceFileEntry[];
  directories: WorkspaceDirectoryEntry[];
}

export interface WorkspaceSnapshot extends WorkspaceDirectoryListing {
  workspace_token: string;
}

export type WorkspaceIndexStatus = 'ready' | 'cancelled' | 'invalidated';
export type WorkspaceIndexQueryKind = 'filename' | 'fullText';

export interface WorkspaceIndexLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxAggregateBytes: number;
  maxResults: number;
  maxQueryChars: number;
  maxSnippetChars: number;
}

export interface WorkspaceIndexSkipCounts {
  unsupported: number;
  invalidRelativePath: number;
  duplicatePath: number;
  oversized: number;
  aggregateLimit: number;
  fileCountLimit: number;
}

export interface WorkspaceIndexBuildReport {
  implementationId: string;
  schemaId: string;
  corpusDigest: string;
  limits: WorkspaceIndexLimits;
  inputFiles: number;
  indexedFiles: number;
  indexedBytes: number;
  estimatedIndexBytes: number;
  skipped: WorkspaceIndexSkipCounts;
}

export interface WorkspaceIndexScanReport {
  scannedFiles: number;
  collectedFiles: number;
  collectedBytes: number;
  readErrors: number;
  skipped: WorkspaceIndexSkipCounts;
}

export interface WorkspaceIndexRebuildResponse {
  status: WorkspaceIndexStatus;
  workspaceToken: string;
  indexGeneration: number;
  implementationId: string;
  schemaId: string;
  report: WorkspaceIndexBuildReport;
  scanReport: WorkspaceIndexScanReport;
}

export interface WorkspaceIndexQueryLocation {
  line: number;
  utf8ByteOffset: number;
}

export interface WorkspaceIndexQueryResult {
  relativePath: string;
  snippet: string | null;
  location: WorkspaceIndexQueryLocation | null;
}

export interface WorkspaceIndexQueryResponse {
  status: WorkspaceIndexStatus;
  workspaceToken: string;
  indexGeneration: number;
  implementationId: string;
  schemaId: string;
  truncated: boolean;
  results: WorkspaceIndexQueryResult[];
}

export interface WorkspaceIndexDiscardResponse {
  discarded: boolean;
  indexGeneration: number | null;
}

export interface WorkspaceMutation {
  path: string;
}

export type SnapshotReceipt =
  | { status: 'fresh'; snapshot: WorkspaceSnapshot }
  | { status: 'stale'; workspace_token: string; repair_reason: string }
  | { status: 'not-applicable' };

export interface MutationCommitReceipt<T> {
  committed: T;
  workspace: SnapshotReceipt;
}

export type MutationKind = 'create' | 'delete' | 'rename' | 'write';

export type MutationOutcome<T> =
  | { status: 'confirmed-not-committed'; message: string }
  | { status: 'confirmed-committed'; receipt: MutationCommitReceipt<T> }
  | { status: 'indeterminate'; operation: MutationKind; paths: string[]; recovery_message: string };

export interface RenameWorkspaceEntryResponse {
  entry_kind: 'file' | 'directory';
  new_path: string;
  old_path: string;
}

export interface DeleteWorkspaceEntryResponse {
  deleted_path: string;
}

export const SETTINGS_SCHEMA_VERSION = 1 as const;

export type SettingsSkinId =
  | 'original'
  | 'jinxiu-zhusha'
  | 'ruyao-tianqing'
  | 'qinghua-jilan'
  | 'songke-zhuying'
  | 'gujuan-nuanxing'
  | 'zhuying-qingci'
  | 'jiushu-huangzhi'
  | 'shanshui-yemo';

export type SettingsLocaleMode = 'system' | 'zh-CN' | 'en';

export interface AppSettings {
  autosaveEnabled: boolean;
  autosaveDelayMs: number;
  spellcheckEnabled: boolean;
  wikilinksEnabled: boolean;
  resourceDirectory: string;
  editorPaneRatio: number;
  selectedSkin: SettingsSkinId;
  followSystemTheme: boolean;
  localeMode: SettingsLocaleMode;
  shortcuts: Record<string, string>;
  exportProfiles: Record<string, unknown>;
}

export interface SettingsEnvelope {
  schemaVersion: typeof SETTINGS_SCHEMA_VERSION;
  revision: number;
  settings: AppSettings;
}

export interface SettingsError {
  code: string;
  message: string;
  canReset: boolean;
}
