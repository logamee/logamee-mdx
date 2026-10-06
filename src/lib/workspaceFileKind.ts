export { decodeFileVersion } from './workspaceDecodePrimitives';
export {
  decodeWorkspaceFileKind,
  getWorkspacePresentation,
  type WorkspacePresentation,
} from './workspaceKindPresentation';
export { decodeOpenFileResponse } from './openFileResponseDecode';
export {
  decodeDeleteWorkspaceEntryResponse,
  decodeRenameWorkspaceEntryResponse,
  decodeWorkspaceMutation,
  decodeWorkspaceSnapshot,
} from './workspaceSnapshotDecode';
export { decodeMutationOutcome, decodeSnapshotReceipt } from './workspaceMutationOutcomeDecode';
