//! Tauri command surface for active-document watching.
use super::native::{ create_native_handle };
use super::disk::{ read_authorized_disk };
use super::*;


pub(crate) fn start_active_document_watch_inner(
    state: &AppState,
    app: &AppHandle,
    owner: &str,
    path: impl AsRef<Path>,
    document_id: String,
    document_generation: u64,
) -> Result<ActiveDocumentWatchRegistration, String> {
    validate_main_owner(owner)?;
    validate_document_identity(&document_id, document_generation)?;
    let canonical = ensure_authorized_existing_file_inner(state, path)?;
    let file_kind = WorkspaceFileKind::classify(&canonical)
        .ok_or_else(|| "The active file type cannot be monitored".to_string())?;
    let parent = canonical
        .parent()
        .ok_or_else(|| "The active file has no parent directory".to_string())?
        .to_path_buf();
    let service = state.active_document_watch();
    let _lane = service.lock_lane()?;
    let (watch_id, previous) = service.replace_pending(
        document_id,
        document_generation,
        canonical.clone(),
        parent.clone(),
        file_kind,
    )?;
    if let Some(previous) = previous {
        stop_entry(previous);
    }
    let handle = match create_native_handle(app.clone(), watch_id.clone(), &parent) {
        Ok(handle) => handle,
        Err(error) => {
            if let Some(entry) = service.remove_if_current(&watch_id) {
                stop_entry(entry);
            }
            return Err(error);
        }
    };
    service.attach_handle(&watch_id, handle)?;
    let (snapshot, file_identity, file_binding) = match read_initial_snapshot(state, &canonical) {
        Ok(initial) => initial,
        Err(_) => {
            if let Some(entry) = service.remove_if_current(&watch_id) {
                stop_entry(entry);
            }
            return Err("Monitoring could not read the active file".to_string());
        }
    };
    service.finalize_registration(&watch_id, snapshot, file_identity, file_binding)
}

fn read_initial_snapshot(
    state: &AppState,
    canonical: &Path,
) -> Result<
    (
        ActiveDocumentDiskSnapshot,
        Option<String>,
        Option<Arc<fs::File>>,
    ),
    (),
> {
    match read_authorized_disk(state, canonical) {
        Ok(DiskRead::Present {
            file,
            file_identity,
            file_binding,
            ..
        }) => Ok((
            ActiveDocumentDiskSnapshot::Present {
                file,
                preview_revision: 1,
            },
            Some(file_identity),
            Some(file_binding),
        )),
        Ok(DiskRead::Missing) => Ok((
            ActiveDocumentDiskSnapshot::Missing {
                path: canonical.to_string_lossy().to_string(),
            },
            None,
            None,
        )),
        Err(_) => Err(()),
    }
}

#[tauri::command]
pub(crate) fn start_active_document_watch(
    path: String,
    document_id: String,
    document_generation: u64,
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<ActiveDocumentWatchRegistration, String> {
    start_active_document_watch_inner(
        &state,
        &app,
        window.label(),
        path,
        document_id,
        document_generation,
    )
}

#[tauri::command]
pub(crate) fn activate_active_document_watch(
    watch_id: String,
    document_id: String,
    document_generation: u64,
    registration_sequence: u64,
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    validate_main_owner(window.label())?;
    validate_document_identity(&document_id, document_generation)?;
    if registration_sequence > MAX_SAFE_INTEGER || !protocol_id_is_valid(&watch_id) {
        return Err("Invalid active document monitoring identity".to_string());
    }
    state.active_document_watch().activate(
        &app,
        &watch_id,
        &document_id,
        document_generation,
        registration_sequence,
    )
}

#[tauri::command]
pub(crate) fn reconcile_active_document_watch(
    watch_id: String,
    document_id: String,
    document_generation: u64,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<ActiveDocumentWatchSnapshotEnvelope, String> {
    validate_main_owner(window.label())?;
    validate_document_identity(&document_id, document_generation)?;
    if !protocol_id_is_valid(&watch_id) {
        return Err("Invalid active document monitoring identity".to_string());
    }
    state.active_document_watch().reconcile_command(
        &state,
        &watch_id,
        &document_id,
        document_generation,
    )
}

#[tauri::command]
pub(crate) fn stop_active_document_watch(
    watch_id: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    validate_main_owner(window.label())?;
    if !protocol_id_is_valid(&watch_id) {
        return Err("Invalid active document monitoring identity".to_string());
    }
    state.active_document_watch().stop(&watch_id)
}
