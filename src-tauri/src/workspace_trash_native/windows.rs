//! Windows shell API bindings and pre-delete identity validation.
use std::{
    ffi::{c_void, OsString},
    io::{self, Write},
    os::windows::ffi::{OsStrExt, OsStringExt}, // platform-audit: allow (platform-gated trash transport)
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
};

use ::windows::{ // platform-audit: allow (platform-gated trash transport)
    core::{implement, Ref, Result as WinResult, HRESULT, PCWSTR},
    Win32::{
        Foundation::{E_ABORT, E_FAIL},
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize,
            CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
        },
        UI::Shell::{
            FileOperation, IFileOperation, IFileOperationProgressSink,
            IFileOperationProgressSink_Impl, IShellItem, SHCreateItemFromParsingName,
            FOFX_EARLYFAILURE, FOFX_RECYCLEONDELETE, FOF_NOCONFIRMATION, FOF_NOERRORUI,
            FOF_SILENT, SIGDN_FILESYSPATH,
        },
    },
};

mod sink;
use super::identity::windows_shell_parsing_name_from_wide;
use super::*;

pub(super) fn shell_parsing_name(
    source: &Path,
    expected_identity: &NativeSourceIdentity,
) -> Result<Vec<u16>, NativeTrashError> {
    if !source.is_absolute() {
        return Err(NativeTrashError::new(
            "prepare Windows shell item path",
            "Trash source path must be absolute",
        ));
    }
    let source_wide: Vec<u16> = source.as_os_str().encode_wide().collect();
    let shell_wide = windows_shell_parsing_name_from_wide(&source_wide)
        .map_err(|error| NativeTrashError::new("prepare Windows shell item path", error))?;
    let shell_source = PathBuf::from(OsString::from_wide(&shell_wide));
    let canonical_source = fs::canonicalize(source).map_err(|error| {
        NativeTrashError::new("revalidate Windows shell item source", error)
    })?;
    let canonical_shell_source = fs::canonicalize(&shell_source).map_err(|error| {
        NativeTrashError::new("revalidate Windows shell parsing path", error)
    })?;
    if canonical_shell_source != canonical_source {
        return Err(NativeTrashError::new(
            "revalidate Windows shell parsing path",
            "Shell path does not resolve to the authorized source",
        ));
    }
    ensure_identity_unchanged(&canonical_shell_source, expected_identity)?;

    let mut terminated = shell_wide;
    terminated.push(0);
    Ok(terminated)
}

#[derive(Default)]
struct SinkState {
    destination: Option<PathBuf>,
    post_delete_error: Option<String>,
}

impl SinkState {
    fn record_error(&mut self, error: impl fmt::Display) {
        let error = error.to_string();
        self.post_delete_error = Some(match self.post_delete_error.take() {
            Some(existing) => format!("{existing}; {error}"),
            None => error,
        });
    }
}

#[implement(IFileOperationProgressSink)]
struct ProgressSink {
    state: Arc<Mutex<SinkState>>,
    expected_source_identity: NativeSourceIdentity,
}

pub(super) fn validate_pre_delete_identity(
    item_path: &Path,
    expected_identity: &NativeSourceIdentity,
) -> Result<(), NativeTrashError> {
    ensure_identity_unchanged(item_path, expected_identity)
}

fn record_pre_delete_validation(
    state: &Arc<Mutex<SinkState>>,
    validation: Result<(), NativeTrashError>,
) -> WinResult<()> {
    match validation {
        Ok(()) => Ok(()),
        Err(error) => {
            state
                .lock()
                .map_err(|_| ::windows::core::Error::from(E_FAIL))? // platform-audit: allow (platform-gated trash transport)
                .record_error(error);
            Err(::windows::core::Error::from(E_ABORT)) // platform-audit: allow (platform-gated trash transport)
        }
    }
}

fn operation_error_with_sink_detail(
    operation: &'static str,
    error: impl fmt::Display,
    state: &Arc<Mutex<SinkState>>,
) -> NativeTrashError {
    let mut message = error.to_string();
    if let Some(callback_error) = state
        .lock()
        .ok()
        .and_then(|state| state.post_delete_error.clone())
    {
        message.push_str("; pre-delete validation: ");
        message.push_str(&callback_error);
    }
    NativeTrashError::new(operation, message)
}

#[allow(non_snake_case)]


pub(super) fn move_to_trash(
    source: &Path,
    kind: TrashEntryKind,
    source_identity: NativeSourceIdentity,
) -> MoveToTrash<NativeTrashReceipt, NativeTrashError> {
    let source = source.to_path_buf();
    let result =
        match thread::spawn(move || unsafe { move_on_sta(source, kind, source_identity) })
            .join()
        {
            Ok(result) => result,
            Err(_) => MoveToTrash::Rejected {
                error: NativeTrashError::new(
                    "start Windows Trash operation",
                    "STA thread panicked",
                ),
            },
        };
    result
}

unsafe fn move_on_sta(
    source: PathBuf,
    kind: TrashEntryKind,
    source_identity: NativeSourceIdentity,
) -> MoveToTrash<NativeTrashReceipt, NativeTrashError> {
    if let Err(error) = ensure_identity_unchanged(&source, &source_identity) {
        return MoveToTrash::Rejected { error };
    }
    let initialized = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    if initialized.is_err() {
        return MoveToTrash::Rejected {
            error: NativeTrashError::new(
                "initialize Windows Trash STA",
                format!("{initialized:?}"),
            ),
        };
    }
    struct ComGuard;
    impl Drop for ComGuard {
        fn drop(&mut self) {
            unsafe { CoUninitialize() }
        }
    }
    let _guard = ComGuard;
    let path = match shell_parsing_name(&source, &source_identity) {
        Ok(path) => path,
        Err(error) => return MoveToTrash::Rejected { error },
    };
    let item: IShellItem = match SHCreateItemFromParsingName(PCWSTR(path.as_ptr()), None) {
        Ok(item) => item,
        Err(error) => {
            return MoveToTrash::Rejected {
                error: NativeTrashError::new("open Windows shell item", error),
            }
        }
    };
    let operation: IFileOperation =
        match CoCreateInstance(&FileOperation, None, CLSCTX_INPROC_SERVER) {
            Ok(operation) => operation,
            Err(error) => {
                return MoveToTrash::Rejected {
                    error: NativeTrashError::new("create Windows Trash operation", error),
                }
            }
        };
    let flags = FOFX_RECYCLEONDELETE
        | FOFX_EARLYFAILURE
        | FOF_NOCONFIRMATION
        | FOF_NOERRORUI
        | FOF_SILENT;
    if let Err(error) = operation.SetOperationFlags(flags) {
        return MoveToTrash::Rejected {
            error: NativeTrashError::new("configure Windows Trash operation", error),
        };
    }
    let state = Arc::new(Mutex::new(SinkState::default()));
    let sink: IFileOperationProgressSink = ProgressSink {
        state: Arc::clone(&state),
        expected_source_identity: source_identity.clone(),
    }
    .into();
    if let Err(error) = operation.DeleteItem(&item, &sink) {
        return MoveToTrash::Rejected {
            error: NativeTrashError::new("queue Windows Trash operation", error),
        };
    }
    if let Err(error) = operation.PerformOperations() {
        return MoveToTrash::PossiblyMoved {
            recovery_receipt: receipt_from_state(&state, kind, &source_identity),
            error: operation_error_with_sink_detail(
                "perform Windows Trash operation",
                error,
                &state,
            ),
        };
    }
    match operation.GetAnyOperationsAborted() {
        Ok(aborted) if aborted.as_bool() => {
            return MoveToTrash::PossiblyMoved {
                recovery_receipt: receipt_from_state(&state, kind, &source_identity),
                error: operation_error_with_sink_detail(
                    "perform Windows Trash operation",
                    "operation was aborted",
                    &state,
                ),
            }
        }
        Err(error) => {
            return MoveToTrash::PossiblyMoved {
                recovery_receipt: receipt_from_state(&state, kind, &source_identity),
                error: operation_error_with_sink_detail(
                    "inspect Windows Trash completion",
                    error,
                    &state,
                ),
            }
        }
        _ => {}
    }
    let state = match state.lock() {
        Ok(state) => state,
        Err(_) => {
            return MoveToTrash::PossiblyMoved {
                recovery_receipt: None,
                error: NativeTrashError::new(
                    "obtain Windows recycle-bin receipt",
                    "progress sink state was unavailable",
                ),
            }
        }
    };
    match (&state.destination, &state.post_delete_error) {
        (Some(destination), None) => MoveToTrash::Placed {
            recovery_receipt: NativeTrashReceipt {
                destination: destination.clone(),
                kind,
                source_identity,
            },
        },
        (destination, error) => MoveToTrash::PossiblyMoved {
            recovery_receipt: destination.as_ref().map(|destination| NativeTrashReceipt {
                destination: destination.clone(),
                kind,
                source_identity: source_identity.clone(),
            }),
            error: NativeTrashError::new(
                "obtain Windows recycle-bin receipt",
                error.as_deref().unwrap_or("no recycled item was reported"),
            ),
        },
    }
}

fn receipt_from_state(
    state: &Arc<Mutex<SinkState>>,
    kind: TrashEntryKind,
    source_identity: &NativeSourceIdentity,
) -> Option<NativeTrashReceipt> {
    state
        .lock()
        .ok()
        .and_then(|state| state.destination.clone())
        .map(|destination| NativeTrashReceipt {
            destination,
            kind,
            source_identity: source_identity.clone(),
        })
}

unsafe fn shell_item_path(item: &IShellItem) -> WinResult<PathBuf> {
    let value = item.GetDisplayName(SIGDN_FILESYSPATH)?;
    let path = value.to_string();
    CoTaskMemFree(Some(value.0.cast()));
    Ok(PathBuf::from(path?))
}

pub(super) fn verify_placement(
    receipt: &NativeTrashReceipt,
) -> PlacementVerification<NativeTrashError> {
    match fs::symlink_metadata(&receipt.destination) {
        Ok(metadata) if verify_kind(&metadata, receipt.kind) => {
            match verify_receipt_identity(receipt) {
                Ok(true) => PlacementVerification::Proven,
                Ok(false) => PlacementVerification::Mismatch,
                Err(error) => PlacementVerification::Unobservable { error },
            }
        }
        Ok(_) => PlacementVerification::Mismatch,
        Err(error) if error.kind() == io::ErrorKind::NotFound => PlacementVerification::Missing,
        Err(error) => PlacementVerification::Unobservable {
            error: NativeTrashError::new("observe Windows recycle-bin receipt", error),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pre_delete_callback_aborts_a_replacement_and_retains_its_reason() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("note.md");
        fs::write(&source, "authorized").unwrap();
        let canonical = fs::canonicalize(&source).unwrap();
        let expected = capture_source_identity(&canonical, TrashEntryKind::File).unwrap();
        let source_for_callback = source.clone();
        let (code, recorded, propagated) = thread::spawn(move || unsafe {
            CoInitializeEx(None, COINIT_APARTMENTTHREADED).unwrap();
            struct TestComGuard;
            impl Drop for TestComGuard {
                fn drop(&mut self) {
                    unsafe { CoUninitialize() }
                }
            }
            let _guard = TestComGuard;
            let shell_name = shell_parsing_name(&canonical, &expected).unwrap();
            let item: IShellItem =
                SHCreateItemFromParsingName(PCWSTR(shell_name.as_ptr()), None).unwrap();
            fs::remove_file(&source_for_callback).unwrap();
            fs::write(&source_for_callback, "replacement").unwrap();
            let state = Arc::new(Mutex::new(SinkState::default()));
            let sink: IFileOperationProgressSink = ProgressSink {
                state: Arc::clone(&state),
                expected_source_identity: expected,
            }
            .into();

            let error = sink.PreDeleteItem(0, &item).unwrap_err();
            let recorded = state.lock().unwrap().post_delete_error.clone().unwrap();
            let propagated = operation_error_with_sink_detail(
                "perform Windows Trash operation",
                "operation was aborted",
                &state,
            );
            (error.code(), recorded, propagated)
        })
        .join()
        .unwrap();

        assert_eq!(code, E_ABORT);
        assert!(recorded.contains("source changed"));
        assert!(propagated.message.contains(&recorded));
        assert_eq!(fs::read_to_string(&source).unwrap(), "replacement");
    }
}
