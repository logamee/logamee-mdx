use std::{
    fs,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    thread,
};
use tempfile::tempdir;
use crate::durable_write::{durable_write, DurableWriteOutcome, ExpectedFileState};
use crate::models::{Settings, SettingsErrorCode};
struct CountingWriter {
    calls: Arc<AtomicUsize>,
}
impl SettingsWriter for CountingWriter {
    fn write(
        &self,
        destination: &std::path::Path,
        bytes: &[u8],
        expected: &ExpectedFileState,
    ) -> std::io::Result<DurableWriteOutcome> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        durable_write(destination, bytes, expected)
    }
}
fn counting_store(app_data_dir: std::path::PathBuf) -> (SettingsStore, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let store = SettingsStore::with_writer(
        app_data_dir,
        Arc::new(CountingWriter {
            calls: calls.clone(),
        }),
    );
    (store, calls)
}
struct ReplaceAfterPrepare {
    replacement: Vec<u8>,
}
impl SettingsPrepareHook for ReplaceAfterPrepare {
    fn after_prepare(&self, store_path: &std::path::Path) {
        fs::create_dir_all(store_path.parent().unwrap()).unwrap();
        fs::write(store_path, &self.replacement).unwrap();
    }
}
fn racing_store(app_data_dir: std::path::PathBuf, replacement: Vec<u8>) -> SettingsStore {
    SettingsStore::with_writer_and_hook(
        app_data_dir,
        Arc::new(super::DurableSettingsWriter),
        Arc::new(ReplaceAfterPrepare { replacement }),
    )
}

use super::*;

#[test]
fn absolute_resource_directory_is_a_persisted_preference_not_an_authority() {
    let directory = tempdir().unwrap();
    let resources = tempdir().unwrap();
    let store = SettingsStore::new(directory.path().to_path_buf());
    let initial = store.load_or_create().unwrap();
    let mut settings = initial.settings;
    settings.resource_directory = resources.path().to_string_lossy().to_string();

    let saved = store.update(initial.revision, settings.clone()).unwrap();

    assert_eq!(
        saved.settings.resource_directory,
        settings.resource_directory
    );
    assert_eq!(
        SettingsStore::new(directory.path().to_path_buf())
            .load_or_create()
            .unwrap()
            .settings
            .resource_directory,
        settings.resource_directory
    );
}

#[test]
fn every_persistence_path_uses_the_injected_durable_writer() {
    let directory = tempdir().unwrap();
    let (store, writes) = counting_store(directory.path().to_path_buf());

    let initial = store.load_or_create().unwrap();
    let updated = store.update(initial.revision, Settings::default()).unwrap();
    store.reset(Some(updated.revision)).unwrap();

    assert_eq!(writes.load(Ordering::SeqCst), 3);
}

#[test]
fn concurrent_updates_are_serialized_with_monotonic_persisted_revisions() {
    let directory = tempdir().unwrap();
    let store = Arc::new(SettingsStore::new(directory.path().to_path_buf()));
    store.load_or_create().unwrap();
    let mut joins = Vec::new();
    for delay in [500, 750, 1_250, 2_000] {
        let store = store.clone();
        joins.push(thread::spawn(move || {
            let mut settings = Settings::default();
            settings.autosave_delay_ms = delay;
            loop {
                let current = store.load().unwrap();
                match store.update(current.revision, settings.clone()) {
                    Ok(envelope) => break envelope.revision,
                    Err(error) if error.code == SettingsErrorCode::Conflict => continue,
                    Err(error) => panic!("unexpected settings update error: {error:?}"),
                }
            }
        }));
    }
    let mut revisions = joins
        .into_iter()
        .map(|join| join.join().unwrap())
        .collect::<Vec<_>>();
    revisions.sort_unstable();

    assert_eq!(revisions, vec![2, 3, 4, 5]);
    assert_eq!(store.load().unwrap().revision, 5);
}

#[test]
fn stale_client_update_and_reset_conflict_without_overwriting_or_calling_writer() {
    let directory = tempdir().unwrap();
    let (store, writes) = counting_store(directory.path().to_path_buf());
    let initial = store.load_or_create().unwrap();
    let mut newer = initial.settings.clone();
    newer.autosave_delay_ms = 2_000;
    let committed = store.update(initial.revision, newer).unwrap();
    let committed_bytes = fs::read(store.store_path()).unwrap();
    let writes_after_commit = writes.load(Ordering::SeqCst);

    let mut stale = initial.settings;
    stale.autosave_delay_ms = 5_000;
    let update_error = store.update(initial.revision, stale).unwrap_err();
    let reset_error = store.reset(Some(initial.revision)).unwrap_err();

    assert_eq!(committed.revision, initial.revision + 1);
    assert_eq!(update_error.code, SettingsErrorCode::Conflict);
    assert_eq!(reset_error.code, SettingsErrorCode::Conflict);
    assert_eq!(store.load().unwrap(), committed);
    assert_eq!(fs::read(store.store_path()).unwrap(), committed_bytes);
    assert_eq!(writes.load(Ordering::SeqCst), writes_after_commit);
}

#[test]
fn prepared_expected_version_is_never_refreshed_after_external_replacement() {
    let future = br#"{"schemaVersion":999,"future":true}"#.to_vec();
    let malformed = b"external malformed".to_vec();
    let mut valid_external = Settings::default();
    valid_external.autosave_delay_ms = 9_000;
    let valid_external = serde_json::to_vec(&crate::models::SettingsEnvelope {
        schema_version: CURRENT_SETTINGS_SCHEMA_VERSION,
        revision: 44,
        settings: valid_external,
    })
    .unwrap();

    for replacement in [future, malformed, valid_external] {
        let directory = tempdir().unwrap();
        let baseline_store = SettingsStore::new(directory.path().to_path_buf());
        let initial = baseline_store.load_or_create().unwrap();
        let store = racing_store(directory.path().to_path_buf(), replacement.clone());
        let mut update = initial.settings;
        update.autosave_delay_ms = 3_000;

        let error = store.update(initial.revision, update).unwrap_err();

        assert_eq!(error.code, SettingsErrorCode::Conflict);
        assert_eq!(fs::read(store.store_path()).unwrap(), replacement);
    }
}

#[test]
fn recovery_reset_and_missing_create_keep_their_prepared_preconditions() {
    let future = br#"{"schemaVersion":999,"future":true}"#.to_vec();

    let recovery_directory = tempdir().unwrap();
    let recovery_store = racing_store(recovery_directory.path().to_path_buf(), future.clone());
    fs::create_dir_all(recovery_store.root_path()).unwrap();
    fs::write(recovery_store.store_path(), b"original malformed").unwrap();
    let recovery_error = recovery_store.reset(None).unwrap_err();
    assert_eq!(recovery_error.code, SettingsErrorCode::Conflict);
    assert_eq!(fs::read(recovery_store.store_path()).unwrap(), future);

    let missing_directory = tempdir().unwrap();
    let missing_store = racing_store(missing_directory.path().to_path_buf(), future.clone());
    let create_error = missing_store.update(0, Settings::default()).unwrap_err();
    assert_eq!(create_error.code, SettingsErrorCode::Conflict);
    assert_eq!(fs::read(missing_store.store_path()).unwrap(), future);
}

#[cfg(unix)]
#[test]
fn settings_storage_uses_private_app_data_permissions() {
    use std::os::unix::fs::PermissionsExt;
    let directory = tempdir().unwrap();
    let store = SettingsStore::new(directory.path().to_path_buf());

    store.load_or_create().unwrap();

    assert_eq!(
        fs::metadata(store.root_path())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(store.store_path())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}

#[test]
fn shortcut_settings_accept_the_complete_frontend_default_profile() {
    // The settings dialog resolves an empty stored profile into the FULL
    // frontend default profile (src/lib/shortcutProfiles.ts) before
    // saving. The backend whitelist must accept every frontend action —
    // including the editor-font adjustments — or every first settings
    // save is rejected with "Shortcut action is not supported."
    let directory = tempdir().unwrap();
    let store = SettingsStore::new(directory.path().to_path_buf());
    let mut settings = Settings::default();
    settings.shortcuts = [
        ("save", "Mod+S"),
        ("saveAs", "Mod+Shift+S"),
        ("quickOpen", "Mod+P"),
        ("workspaceSearch", "Mod+Shift+F"),
        ("export", "Mod+Shift+E"),
        ("settings", "Mod+,"),
        ("editorFontLarger", "Mod+="),
        ("editorFontSmaller", "Mod+-"),
        ("editorFontReset", "Mod+0"),
    ]
    .into_iter()
    .map(|(action, shortcut)| (action.to_string(), shortcut.to_string()))
    .collect();
    let saved = store.update(0, settings.clone()).unwrap();
    assert_eq!(saved.settings.shortcuts, settings.shortcuts);
}

#[test]
fn shortcut_settings_reject_unknown_actions_and_malformed_bindings() {
    let directory = tempdir().unwrap();
    let store = SettingsStore::new(directory.path().to_path_buf());
    let mut unknown = Settings::default();
    unknown
        .shortcuts
        .insert("launchMissiles".to_string(), "Mod+M".to_string());
    assert_eq!(
        store.update(0, unknown).unwrap_err().code,
        SettingsErrorCode::Invalid
    );

    let mut malformed = Settings::default();
    malformed
        .shortcuts
        .insert("save".to_string(), "S".to_string());
    assert_eq!(
        store.update(0, malformed).unwrap_err().code,
        SettingsErrorCode::Invalid
    );

    let mut conflicts_with_default = Settings::default();
    conflicts_with_default
        .shortcuts
        .insert("save".to_string(), "Mod+P".to_string());
    assert_eq!(
        store.update(0, conflicts_with_default).unwrap_err().code,
        SettingsErrorCode::Invalid
    );

    let mut unsupported_key = Settings::default();
    unsupported_key
        .shortcuts
        .insert("save".to_string(), "Mod+not-a-key".to_string());
    assert_eq!(
        store.update(0, unsupported_key).unwrap_err().code,
        SettingsErrorCode::Invalid
    );

    let mut duplicate_modifier = Settings::default();
    duplicate_modifier
        .shortcuts
        .insert("save".to_string(), "Mod+Mod+S".to_string());
    assert_eq!(
        store.update(0, duplicate_modifier).unwrap_err().code,
        SettingsErrorCode::Invalid
    );
}
