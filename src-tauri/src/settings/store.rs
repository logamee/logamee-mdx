//! Durable settings store: locked observe/migrate/persist cycle.
use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use crate::durable_write::{
    read_versioned_file, DurableWriteOutcome, ExpectedFileState,
};
use crate::models::{Settings, SettingsEnvelope, SettingsError, SettingsErrorCode};

use super::errors::{
    invalid_error, map_read_error, next_revision, persistence_error, revision_conflict,
    set_private_directory_permissions, set_private_file_permissions,
};
#[cfg(test)]
use super::errors::not_initialized_error;
#[cfg(test)]
use std::path::Path;
use super::validation::validate_settings;
use super::{
    DurableSettingsWriter, NoopSettingsPrepareHook, SettingsPrepareHook, SettingsWriter,
    CURRENT_SETTINGS_SCHEMA_VERSION, MAX_SETTINGS_BYTES, SETTINGS_DIRECTORY, SETTINGS_FILE,
};
use super::{default_envelope, expected_file_state, LoadedSettings, ObservedSettings, VersionProbe, SettingsV0};

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

    pub(crate) fn with_writer(app_data_dir: PathBuf, writer: Arc<dyn SettingsWriter>) -> Self {
        Self::with_writer_and_hook(app_data_dir, writer, Arc::new(NoopSettingsPrepareHook))
    }

    pub(crate) fn with_writer_and_hook(
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
