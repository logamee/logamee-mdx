use std::{
    fs, io,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
};

use serde::Deserialize;

use crate::{
    durable_write::{
        durable_write, read_versioned_file, DurableWriteOutcome, ExpectedFileState, FileVersion,
    },
    models::{Settings, SettingsEnvelope, SettingsError, SettingsErrorCode},
};

pub(crate) const CURRENT_SETTINGS_SCHEMA_VERSION: u32 = 1;
pub(crate) const MAX_SETTINGS_BYTES: usize = 64 * 1024;
const SETTINGS_DIRECTORY: &str = "settings";
const SETTINGS_FILE: &str = "settings.json";

trait SettingsWriter: Send + Sync {
    fn write(
        &self,
        destination: &Path,
        bytes: &[u8],
        expected: &ExpectedFileState,
    ) -> io::Result<DurableWriteOutcome>;
}

struct DurableSettingsWriter;

trait SettingsPrepareHook: Send + Sync {
    fn after_prepare(&self, store_path: &Path);
}

struct NoopSettingsPrepareHook;

impl SettingsPrepareHook for NoopSettingsPrepareHook {
    fn after_prepare(&self, _store_path: &Path) {}
}

impl SettingsWriter for DurableSettingsWriter {
    fn write(
        &self,
        destination: &Path,
        bytes: &[u8],
        expected: &ExpectedFileState,
    ) -> io::Result<DurableWriteOutcome> {
        durable_write(destination, bytes, expected)
    }
}

pub(crate) struct SettingsStore {
    root: PathBuf,
    store_path: PathBuf,
    operation_lock: Mutex<()>,
    writer: Arc<dyn SettingsWriter>,
    prepare_hook: Arc<dyn SettingsPrepareHook>,
}

impl SettingsStore {
    pub(crate) fn new(app_data_dir: PathBuf) -> Self {
        Self::with_writer(app_data_dir, Arc::new(DurableSettingsWriter))
    }

    fn with_writer(app_data_dir: PathBuf, writer: Arc<dyn SettingsWriter>) -> Self {
        Self::with_writer_and_hook(app_data_dir, writer, Arc::new(NoopSettingsPrepareHook))
    }

    fn with_writer_and_hook(
        app_data_dir: PathBuf,
        writer: Arc<dyn SettingsWriter>,
        prepare_hook: Arc<dyn SettingsPrepareHook>,
    ) -> Self {
        let root = app_data_dir.join(SETTINGS_DIRECTORY);
        let store_path = root.join(SETTINGS_FILE);
        Self {
            root,
            store_path,
            operation_lock: Mutex::new(()),
            writer,
            prepare_hook,
        }
    }

    #[cfg(test)]
    pub(crate) fn root_path(&self) -> &Path {
        &self.root
    }

    #[cfg(test)]
    pub(crate) fn store_path(&self) -> &Path {
        &self.store_path
    }

    pub(crate) fn load_or_create(&self) -> Result<SettingsEnvelope, SettingsError> {
        let _guard = self.lock()?;
        let observed = self.observe_locked()?;
        match observed
            .as_ref()
            .map(|observed| self.parse_observed(observed))
        {
            Some(Ok(LoadedSettings::Current(envelope))) => Ok(envelope),
            Some(Ok(LoadedSettings::Migrated(envelope))) => {
                let expected = expected_file_state(observed.as_ref());
                self.prepare_persist()?;
                self.persist_locked(&envelope, &expected)?;
                Ok(envelope)
            }
            None => {
                let envelope = default_envelope();
                self.prepare_persist()?;
                self.persist_locked(&envelope, &ExpectedFileState::Absent)?;
                Ok(envelope)
            }
            Some(Err(error)) => Err(error),
        }
    }

    #[cfg(test)]
    pub(crate) fn load(&self) -> Result<SettingsEnvelope, SettingsError> {
        let _guard = self.lock()?;
        let observed = self.observe_locked()?.ok_or_else(not_initialized_error)?;
        match self.parse_observed(&observed)? {
            LoadedSettings::Current(envelope) | LoadedSettings::Migrated(envelope) => Ok(envelope),
        }
    }

    pub(crate) fn update(
        &self,
        expected_revision: u64,
        settings: Settings,
    ) -> Result<SettingsEnvelope, SettingsError> {
        validate_settings(&settings)?;
        let _guard = self.lock()?;
        let observed = self.observe_locked()?;
        let current_revision = match observed.as_ref() {
            Some(observed) => match self.parse_observed(observed)? {
                LoadedSettings::Current(envelope) | LoadedSettings::Migrated(envelope) => {
                    envelope.revision
                }
            },
            None => 0,
        };
        if expected_revision != current_revision {
            return Err(revision_conflict());
        }
        let revision = next_revision(current_revision)?;
        let envelope = SettingsEnvelope {
            schema_version: CURRENT_SETTINGS_SCHEMA_VERSION,
            revision,
            settings,
        };
        let expected = expected_file_state(observed.as_ref());
        self.prepare_persist()?;
        self.persist_locked(&envelope, &expected)?;
        Ok(envelope)
    }

    pub(crate) fn reset(
        &self,
        expected_revision: Option<u64>,
    ) -> Result<SettingsEnvelope, SettingsError> {
        let _guard = self.lock()?;
        let observed = self.observe_locked()?;
        let revision = match observed.as_ref() {
            None => {
                if expected_revision.is_some_and(|revision| revision != 0) {
                    return Err(revision_conflict());
                }
                1
            }
            Some(observed) => match self.parse_observed(observed) {
                Ok(LoadedSettings::Current(envelope) | LoadedSettings::Migrated(envelope)) => {
                    if expected_revision != Some(envelope.revision) {
                        return Err(revision_conflict());
                    }
                    next_revision(envelope.revision)?
                }
                Err(error) if error.code == SettingsErrorCode::UnsupportedVersion => {
                    return Err(error);
                }
                Err(_) => {
                    if expected_revision.is_some() {
                        return Err(revision_conflict());
                    }
                    1
                }
            },
        };
        let mut envelope = default_envelope();
        envelope.revision = revision;
        let expected = expected_file_state(observed.as_ref());
        self.prepare_persist()?;
        self.persist_locked(&envelope, &expected)?;
        Ok(envelope)
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, ()>, SettingsError> {
        self.operation_lock.lock().map_err(|_| {
            persistence_error(
                "Settings are temporarily unavailable because the settings lock failed.",
            )
        })
    }

    fn prepare_persist(&self) -> Result<(), SettingsError> {
        self.ensure_storage()?;
        self.prepare_hook.after_prepare(&self.store_path);
        Ok(())
    }

    fn observe_locked(&self) -> Result<Option<ObservedSettings>, SettingsError> {
        read_versioned_file(&self.store_path, MAX_SETTINGS_BYTES)
            .map(|observed| {
                observed.map(|observed| ObservedSettings {
                    bytes: observed.bytes,
                    version: observed.version,
                })
            })
            .map_err(map_read_error)
    }

    fn parse_observed(&self, observed: &ObservedSettings) -> Result<LoadedSettings, SettingsError> {
        let probe: VersionProbe =
            serde_json::from_slice(&observed.bytes).map_err(|_| SettingsError {
                code: SettingsErrorCode::Malformed,
                message: "The settings file is not valid JSON or text encoding.".to_string(),
                can_reset: true,
            })?;
        if probe.schema_version > CURRENT_SETTINGS_SCHEMA_VERSION {
            return Err(SettingsError {
                code: SettingsErrorCode::UnsupportedVersion,
                message:
                    "These settings were created by a newer version of mdx and were left unchanged."
                        .to_string(),
                can_reset: false,
            });
        }
        match probe.schema_version {
            CURRENT_SETTINGS_SCHEMA_VERSION => {
                let envelope: SettingsEnvelope =
                    serde_json::from_slice(&observed.bytes).map_err(|_| {
                        invalid_error("The settings file has missing or unknown fields.")
                    })?;
                validate_settings(&envelope.settings)?;
                Ok(LoadedSettings::Current(envelope))
            }
            0 => {
                let prior: SettingsV0 = serde_json::from_slice(&observed.bytes)
                    .map_err(|_| invalid_error("The older settings file has invalid fields."))?;
                let mut settings = Settings::default();
                settings.autosave_enabled = prior.autosave.unwrap_or(settings.autosave_enabled);
                settings.autosave_delay_ms = prior
                    .autosave_delay_ms
                    .unwrap_or(settings.autosave_delay_ms);
                settings.spellcheck_enabled =
                    prior.spellcheck.unwrap_or(settings.spellcheck_enabled);
                settings.resource_directory = prior
                    .resource_directory
                    .unwrap_or(settings.resource_directory);
                validate_settings(&settings)?;
                Ok(LoadedSettings::Migrated(SettingsEnvelope {
                    schema_version: CURRENT_SETTINGS_SCHEMA_VERSION,
                    revision: 1,
                    settings,
                }))
            }
            _ => Err(invalid_error("The settings schema version is invalid.")),
        }
    }

    fn persist_locked(
        &self,
        envelope: &SettingsEnvelope,
        expected: &ExpectedFileState,
    ) -> Result<(), SettingsError> {
        validate_settings(&envelope.settings)?;
        let bytes = serde_json::to_vec_pretty(envelope)
            .map_err(|error| persistence_error(format!("Cannot prepare settings: {error}")))?;
        if bytes.len() > MAX_SETTINGS_BYTES {
            return Err(invalid_error("The settings payload is too large."));
        }
        let outcome = self
            .writer
            .write(&self.store_path, &bytes, expected)
            .map_err(|error| persistence_error(format!("Cannot save settings: {error}")))?;
        match outcome {
            DurableWriteOutcome::ConfirmedCommitted { displaced_path, .. } => {
                if let Some(path) = displaced_path {
                    let _ = fs::remove_file(path);
                }
                set_private_file_permissions(&self.store_path).map_err(|error| {
                    persistence_error(format!("Cannot secure the settings file: {error}"))
                })?;
                Ok(())
            }
            DurableWriteOutcome::Conflict { .. } => Err(SettingsError {
                code: SettingsErrorCode::Conflict,
                message: "Settings changed in another process. Reload them and try again."
                    .to_string(),
                can_reset: false,
            }),
            DurableWriteOutcome::ConfirmedNotCommitted { message, .. } => Err(persistence_error(
                format!("Settings were not saved. {message}"),
            )),
            DurableWriteOutcome::Indeterminate { message, .. } => Err(persistence_error(format!(
                "The settings save outcome is uncertain. {message}"
            ))),
        }
    }

    fn ensure_storage(&self) -> Result<(), SettingsError> {
        fs::create_dir_all(&self.root).map_err(|error| {
            persistence_error(format!("Cannot create settings storage: {error}"))
        })?;
        set_private_directory_permissions(&self.root)
            .map_err(|error| persistence_error(format!("Cannot secure settings storage: {error}")))
    }
}

fn expected_file_state(observed: Option<&ObservedSettings>) -> ExpectedFileState {
    match observed {
        Some(observed) => ExpectedFileState::Exact {
            version: observed.version.clone(),
        },
        None => ExpectedFileState::Absent,
    }
}

enum LoadedSettings {
    Current(SettingsEnvelope),
    Migrated(SettingsEnvelope),
}

struct ObservedSettings {
    bytes: Vec<u8>,
    version: FileVersion,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VersionProbe {
    schema_version: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SettingsV0 {
    #[serde(rename = "schemaVersion")]
    _schema_version: u32,
    #[serde(default)]
    autosave: Option<bool>,
    #[serde(default)]
    autosave_delay_ms: Option<u32>,
    #[serde(default)]
    spellcheck: Option<bool>,
    #[serde(default)]
    resource_directory: Option<String>,
}

fn default_envelope() -> SettingsEnvelope {
    SettingsEnvelope {
        schema_version: CURRENT_SETTINGS_SCHEMA_VERSION,
        revision: 1,
        settings: Settings::default(),
    }
}

fn validate_settings(settings: &Settings) -> Result<(), SettingsError> {
    if !(250..=60_000).contains(&settings.autosave_delay_ms) {
        return Err(invalid_error(
            "Autosave delay must be between 250 and 60000 milliseconds.",
        ));
    }
    if !settings.editor_pane_ratio.is_finite() || !(0.2..=0.8).contains(&settings.editor_pane_ratio)
    {
        return Err(invalid_error(
            "Editor pane ratio must be between 0.2 and 0.8.",
        ));
    }
    if !matches!(settings.locale_mode.as_str(), "system" | "zh-CN" | "en") {
        return Err(invalid_error("Locale mode is not supported."));
    }
    if !matches!(
        settings.selected_skin.as_str(),
        "original"
            | "jinxiu-zhusha"
            | "ruyao-tianqing"
            | "qinghua-jilan"
            | "songke-zhuying"
            | "gujuan-nuanxing"
            | "zhuying-qingci"
            | "jiushu-huangzhi"
            | "shanshui-yemo"
    ) {
        return Err(invalid_error("Theme selection is not supported."));
    }
    if settings.resource_directory.is_empty() || settings.resource_directory.len() > 4096 {
        return Err(invalid_error("Resource directory is invalid."));
    }
    let resource_path = Path::new(&settings.resource_directory);
    if resource_path.components().any(|component| {
        matches!(component, Component::ParentDir | Component::CurDir)
            || (!resource_path.is_absolute()
                && matches!(component, Component::RootDir | Component::Prefix(_)))
    }) {
        return Err(invalid_error(
            "Resource directory must not contain parent traversal.",
        ));
    }
    const SHORTCUT_DEFAULTS: [(&str, &str); 6] = [
        ("save", "Mod+S"),
        ("saveAs", "Mod+Shift+S"),
        ("quickOpen", "Mod+P"),
        ("workspaceSearch", "Mod+Shift+F"),
        ("export", "Mod+Shift+E"),
        ("settings", "Mod+,"),
    ];
    if settings.shortcuts.len() > SHORTCUT_DEFAULTS.len()
        || settings
            .shortcuts
            .keys()
            .any(|action| !SHORTCUT_DEFAULTS.iter().any(|(known, _)| known == action))
    {
        return Err(invalid_error("Shortcut action is not supported."));
    }
    let mut normalized_shortcuts = std::collections::BTreeSet::new();
    for (action, default_shortcut) in SHORTCUT_DEFAULTS {
        let shortcut = settings
            .shortcuts
            .get(action)
            .map(String::as_str)
            .unwrap_or(default_shortcut);
        let parts = shortcut.split('+').map(str::trim).collect::<Vec<_>>();
        let mut modifiers = parts[..parts.len().saturating_sub(1)]
            .iter()
            .map(|part| part.to_ascii_lowercase())
            .collect::<Vec<_>>();
        let modifiers_are_unique = modifiers
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            == modifiers.len();
        modifiers.sort();
        let modifier_count = modifiers
            .iter()
            .filter(|part| matches!(part.as_str(), "mod" | "ctrl" | "alt" | "shift"))
            .count();
        let key = parts
            .last()
            .copied()
            .unwrap_or_default()
            .to_ascii_lowercase();
        let supported_key = key.len() == 1
            || matches!(
                key.as_str(),
                "enter"
                    | "escape"
                    | "space"
                    | "tab"
                    | "backspace"
                    | "delete"
                    | "arrowup"
                    | "arrowdown"
                    | "arrowleft"
                    | "arrowright"
            )
            || (key.starts_with('f')
                && key[1..]
                    .parse::<u8>()
                    .is_ok_and(|number| (1..=12).contains(&number)));
        let normalized = format!("{}+{key}", modifiers.join("+"));
        if shortcut.len() > 64
            || parts.len() < 2
            || modifier_count + 1 != parts.len()
            || parts
                .last()
                .is_none_or(|key| key.is_empty() || key.len() > 12)
            || !supported_key
            || !modifiers_are_unique
        {
            return Err(invalid_error("Shortcut is invalid."));
        }
        if !normalized_shortcuts.insert(normalized) {
            return Err(invalid_error("Shortcut conflicts with another action."));
        }
    }
    if !settings.export_profiles.is_empty() {
        return Err(invalid_error(
            "Export profile placeholders must remain empty in this version.",
        ));
    }
    Ok(())
}

fn map_read_error(error: io::Error) -> SettingsError {
    match error.kind() {
        io::ErrorKind::NotFound => not_initialized_error(),
        io::ErrorKind::FileTooLarge => SettingsError {
            code: SettingsErrorCode::Oversized,
            message: "The settings file is larger than mdx can safely read.".to_string(),
            can_reset: true,
        },
        _ => persistence_error(format!("Cannot read settings: {error}")),
    }
}

fn not_initialized_error() -> SettingsError {
    SettingsError {
        code: SettingsErrorCode::NotInitialized,
        message: "Settings have not been created yet.".to_string(),
        can_reset: false,
    }
}

fn invalid_error(message: impl Into<String>) -> SettingsError {
    SettingsError {
        code: SettingsErrorCode::Invalid,
        message: message.into(),
        can_reset: true,
    }
}

fn next_revision(current: u64) -> Result<u64, SettingsError> {
    current.checked_add(1).ok_or_else(|| {
        persistence_error("Settings revision capacity has been exhausted; settings were unchanged.")
    })
}

fn revision_conflict() -> SettingsError {
    SettingsError {
        code: SettingsErrorCode::Conflict,
        message: "Settings changed after this view loaded. Reload them and try again.".to_string(),
        can_reset: false,
    }
}

fn persistence_error(message: impl Into<String>) -> SettingsError {
    SettingsError {
        code: SettingsErrorCode::Persistence,
        message: message.into(),
        can_reset: false,
    }
}

#[cfg(unix)]
fn set_private_directory_permissions(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn set_private_directory_permissions(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn set_private_file_permissions(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn set_private_file_permissions(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
        thread,
    };

    use serde_json::json;
    use tempfile::tempdir;

    use crate::durable_write::{durable_write, DurableWriteOutcome, ExpectedFileState};
    use crate::models::{Settings, SettingsErrorCode};

    use super::{
        SettingsPrepareHook, SettingsStore, SettingsWriter, CURRENT_SETTINGS_SCHEMA_VERSION,
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
}
