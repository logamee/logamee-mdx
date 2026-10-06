//! Shared test imports and fixtures.
#[allow(unused_imports)]
pub(super) use super::disk::{ finalize_authorization_transition, resolve_disk_state };
pub(super) use super::native::*;
pub(super) use super::*;
pub(super) use crate::{
    document_save::{DocumentSaveCoordinator, DocumentSaveDisposition, MAIN_SAVE_OWNER},
    durable_write::capture_file_version,
    path_auth::{
        authorize_directory_root_inner, authorize_file_inner, authorize_workspace_file_inner,
        ensure_authorized_write_file_inner,
    },
    workspace_file_kind::{ContentMode, WorkspaceFileKind},
};
pub(super) use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc, Arc,
    },
};
pub(super) use tempfile::{tempdir, tempfile};
pub(super) struct CountingHandle(pub(super) Arc<AtomicUsize>);
impl WatchHandlePort for CountingHandle {
    fn stop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}
pub(super) fn installed_state() -> ActiveDocumentWatchState {
    let state = ActiveDocumentWatchState::default();
    state.install_for_test(
        "watch-1",
        "pane-document-1",
        7,
        PathBuf::from("/workspace/notes.md"),
    );
    state
}
pub(super) fn reconcile_context(path: &Path, file_kind: WorkspaceFileKind) -> ReconcileContext {
    ReconcileContext {
        watch_id: "watch-1".to_string(),
        document_id: "pane-document-1".to_string(),
        document_generation: 7,
        path: path.to_path_buf(),
        parent: path.parent().unwrap().to_path_buf(),
        file_kind,
        write_epoch: 0,
        rename_candidates: Vec::new(),
    }
}
pub(super) fn minimal_docx_zip() -> Vec<u8> {
    pub(super) fn append_u16(bytes: &mut Vec<u8>, value: u16) {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    pub(super) fn append_u32(bytes: &mut Vec<u8>, value: u32) {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    let name = b"[Content_Types].xml";
    let mut bytes = Vec::new();
    append_u32(&mut bytes, 0x0403_4b50);
    append_u16(&mut bytes, 20);
    for _ in 0..4 {
        append_u16(&mut bytes, 0);
    }
    for _ in 0..3 {
        append_u32(&mut bytes, 0);
    }
    append_u16(&mut bytes, name.len() as u16);
    append_u16(&mut bytes, 0);
    bytes.extend_from_slice(name);
    let central_offset = bytes.len() as u32;
    append_u32(&mut bytes, 0x0201_4b50);
    append_u16(&mut bytes, 20);
    append_u16(&mut bytes, 20);
    for _ in 0..4 {
        append_u16(&mut bytes, 0);
    }
    for _ in 0..3 {
        append_u32(&mut bytes, 0);
    }
    append_u16(&mut bytes, name.len() as u16);
    for _ in 0..4 {
        append_u16(&mut bytes, 0);
    }
    for _ in 0..2 {
        append_u32(&mut bytes, 0);
    }
    bytes.extend_from_slice(name);
    let central_size = bytes.len() as u32 - central_offset;
    append_u32(&mut bytes, 0x0605_4b50);
    append_u16(&mut bytes, 0);
    append_u16(&mut bytes, 0);
    append_u16(&mut bytes, 1);
    append_u16(&mut bytes, 1);
    append_u32(&mut bytes, central_size);
    append_u32(&mut bytes, central_offset);
    append_u16(&mut bytes, 0);
    bytes
}
