use std::{
    fs,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};
use serde_json::json;
use tempfile::tempdir;
use crate::durable_write::{durable_write, DurableWriteOutcome, ExpectedFileState};
use crate::models::{Settings, SettingsErrorCode};
use super::{
    SettingsStore, SettingsWriter, CURRENT_SETTINGS_SCHEMA_VERSION,
    MAX_SETTINGS_BYTES,
};
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



#[test]
fn missing_settings_create_and_persist_validated_defaults() {
    let directory = tempdir().unwrap();
    let store = SettingsStore::new(directory.path().to_path_buf());

    let loaded = store.load_or_create().unwrap();

    assert_eq!(loaded.schema_version, CURRENT_SETTINGS_SCHEMA_VERSION);
    assert_eq!(loaded.revision, 1);
    assert_eq!(loaded.settings, Settings::default());
    assert!(loaded.settings.spellcheck_enabled);
    assert!(!loaded.settings.wikilinks_enabled);
    assert_eq!(store.load().unwrap(), loaded);
}

#[test]
fn known_v0_settings_migrate_deterministically_and_survive_restart() {
    let directory = tempdir().unwrap();
    let store = SettingsStore::new(directory.path().to_path_buf());
    fs::create_dir_all(store.root_path()).unwrap();
    fs::write(
        store.store_path(),
        serde_json::to_vec(&json!({
            "schemaVersion": 0,
            "autosave": true,
            "autosaveDelayMs": 2500,
            "spellcheck": false,
            "resourceDirectory": "assets"
        }))
        .unwrap(),
    )
    .unwrap();

    let migrated = store.load_or_create().unwrap();
    let restarted = SettingsStore::new(directory.path().to_path_buf())
        .load_or_create()
        .unwrap();

    assert_eq!(migrated, restarted);
    assert!(migrated.settings.autosave_enabled);
    assert_eq!(migrated.settings.autosave_delay_ms, 2500);
    assert!(!migrated.settings.spellcheck_enabled);
    assert_eq!(migrated.settings.resource_directory, "assets");
    assert!(!migrated.settings.wikilinks_enabled);
}

#[test]
fn unknown_future_version_fails_closed_without_overwriting() {
    let directory = tempdir().unwrap();
    let (store, writes) = counting_store(directory.path().to_path_buf());
    fs::create_dir_all(store.root_path()).unwrap();
    let original = br#"{"schemaVersion":999,"settings":{"future":true}}"#;
    fs::write(store.store_path(), original).unwrap();
    let original_modified = fs::metadata(store.store_path())
        .unwrap()
        .modified()
        .unwrap();

    let error = store.load_or_create().unwrap_err();
    let mut updated = Settings::default();
    updated.spellcheck_enabled = false;
    let update_error = store.update(1, updated).unwrap_err();
    let reset_error = store.reset(None).unwrap_err();

    assert_eq!(error.code, SettingsErrorCode::UnsupportedVersion);
    assert_eq!(update_error.code, SettingsErrorCode::UnsupportedVersion);
    assert_eq!(reset_error.code, SettingsErrorCode::UnsupportedVersion);
    assert!(!error.can_reset);
    assert_eq!(fs::read(store.store_path()).unwrap(), original);
    assert_eq!(
        fs::metadata(store.store_path())
            .unwrap()
            .modified()
            .unwrap(),
        original_modified
    );
    assert_eq!(writes.load(Ordering::SeqCst), 0);
}

#[test]
fn malformed_oversized_and_invalid_settings_are_resettable_and_not_overwritten() {
    let cases = [
        (b"not json".to_vec(), SettingsErrorCode::Malformed),
        (
            vec![b'x'; MAX_SETTINGS_BYTES + 1],
            SettingsErrorCode::Oversized,
        ),
        (vec![0xff, 0xfe, 0xfd], SettingsErrorCode::Malformed),
        (
            serde_json::to_vec(&json!({
                "schemaVersion": CURRENT_SETTINGS_SCHEMA_VERSION,
                "settings": { "autosaveEnabled": true, "autosaveDelayMs": 1 }
            }))
            .unwrap(),
            SettingsErrorCode::Invalid,
        ),
    ];

    for (bytes, expected_code) in cases {
        let directory = tempdir().unwrap();
        let store = SettingsStore::new(directory.path().to_path_buf());
        fs::create_dir_all(store.root_path()).unwrap();
        fs::write(store.store_path(), &bytes).unwrap();

        let error = store.load_or_create().unwrap_err();

        assert_eq!(error.code, expected_code);
        assert!(error.can_reset);
        assert_eq!(fs::read(store.store_path()).unwrap(), bytes);
    }
}

#[test]
fn v1_settings_without_editor_font_size_load_with_default_sixteen() {
    let directory = tempdir().unwrap();
    let store = SettingsStore::new(directory.path().to_path_buf());
    fs::create_dir_all(store.root_path()).unwrap();
    fs::write(
        store.store_path(),
        serde_json::to_vec(&json!({
            "schemaVersion": CURRENT_SETTINGS_SCHEMA_VERSION,
            "revision": 3,
            "settings": {
                "autosaveEnabled": true,
                "autosaveDelayMs": 1500,
                "spellcheckEnabled": true,
                "wikilinksEnabled": false,
                "resourceDirectory": "assets",
                "editorPaneRatio": 0.5,
                "selectedSkin": "original",
                "followSystemTheme": false,
                "localeMode": "system",
                "shortcuts": {},
                "exportProfiles": {}
            }
        }))
        .unwrap(),
    )
    .unwrap();

    let loaded = store.load_or_create().unwrap();

    assert_eq!(loaded.settings.editor_font_size, 16);
}

#[test]
fn editor_font_size_outside_supported_range_is_rejected() {
    let directory = tempdir().unwrap();
    let store = SettingsStore::new(directory.path().to_path_buf());
    let mut too_small = Settings::default();
    too_small.editor_font_size = 11;
    let mut too_large = Settings::default();
    too_large.editor_font_size = 40;

    assert_eq!(
        store.update(0, too_small).unwrap_err().code,
        SettingsErrorCode::Invalid
    );
    assert_eq!(
        store.update(0, too_large).unwrap_err().code,
        SettingsErrorCode::Invalid
    );
}

#[test]
fn reset_persists_defaults_and_restart_observes_them() {
    let directory = tempdir().unwrap();
    let store = SettingsStore::new(directory.path().to_path_buf());
    let mut changed = Settings::default();
    changed.spellcheck_enabled = false;
    changed.wikilinks_enabled = true;
    let changed = store.update(0, changed).unwrap();

    let reset = store.reset(Some(changed.revision)).unwrap();
    let restarted = SettingsStore::new(directory.path().to_path_buf())
        .load_or_create()
        .unwrap();

    assert_eq!(reset.settings, Settings::default());
    assert!(reset.settings.spellcheck_enabled);
    assert!(!reset.settings.wikilinks_enabled);
    assert!(reset.revision > 1);
    assert_eq!(restarted, reset);
}

#[test]
fn shortcut_settings_accept_known_unique_bindings_and_reject_conflicts() {
    let directory = tempdir().unwrap();
    let store = SettingsStore::new(directory.path().to_path_buf());
    let mut settings = Settings::default();
    settings
        .shortcuts
        .insert("save".to_string(), "Mod+S".to_string());
    settings
        .shortcuts
        .insert("quickOpen".to_string(), "Mod+P".to_string());
    let saved = store.update(0, settings.clone()).unwrap();
    assert_eq!(saved.settings.shortcuts, settings.shortcuts);

    settings
        .shortcuts
        .insert("quickOpen".to_string(), "mod+s".to_string());
    let error = store.update(saved.revision, settings).unwrap_err();
    assert_eq!(error.code, SettingsErrorCode::Invalid);
}

#[test]
fn v0_optional_fields_default_and_current_schema_round_trips_exactly() {
    let directory = tempdir().unwrap();
    let store = SettingsStore::new(directory.path().to_path_buf());
    fs::create_dir_all(store.root_path()).unwrap();
    fs::write(
        store.store_path(),
        br#"{"schemaVersion":0,"spellcheck":false}"#,
    )
    .unwrap();

    let migrated = store.load_or_create().unwrap();
    assert_eq!(migrated.settings.autosave_delay_ms, 1_000);
    assert!(!migrated.settings.spellcheck_enabled);
    assert!(!migrated.settings.wikilinks_enabled);

    let migrated_revision = migrated.revision;
    let mut current = migrated.settings;
    current.autosave_enabled = false;
    current.autosave_delay_ms = 5_000;
    current.wikilinks_enabled = true;
    current.resource_directory = "resources/images".to_string();
    current.editor_pane_ratio = 0.65;
    current.selected_skin = "qinghua-jilan".to_string();
    current.follow_system_theme = true;
    current.locale_mode = "en".to_string();
    let saved = store.update(migrated_revision, current.clone()).unwrap();
    let restarted = SettingsStore::new(directory.path().to_path_buf())
        .load_or_create()
        .unwrap();

    assert_eq!(saved.settings, current);
    assert_eq!(restarted, saved);
}
