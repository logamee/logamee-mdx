export interface ExternalFileActionDialogState {
  busy: boolean;
  kind: 'conflict' | 'deleted-draft';
  path: string;
}

export interface DocumentSaveConflictDialogState {
  busy: boolean;
  path: string;
}
