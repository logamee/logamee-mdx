use std::{io, path::Path};

use serde::Deserialize;

use crate::{
    durable_write::{durable_write, DurableWriteOutcome, ExpectedFileState, FileVersion},
    models::{Settings, SettingsEnvelope},
};

pub(crate) const CURRENT_SETTINGS_SCHEMA_VERSION: u32 = 1;
pub(crate) const MAX_SETTINGS_BYTES: usize = 64 * 1024;
const SETTINGS_DIRECTORY: &str = "settings";
const SETTINGS_FILE: &str = "settings.json";

pub(crate) trait SettingsWriter: Send + Sync {
    fn write(
        &self,
        destination: &Path,
        bytes: &[u8],
        expected: &ExpectedFileState,
    ) -> io::Result<DurableWriteOutcome>;
}

pub(crate) struct DurableSettingsWriter;

pub(crate) trait SettingsPrepareHook: Send + Sync {
    fn after_prepare(&self, store_path: &Path);
}

pub(crate) struct NoopSettingsPrepareHook;

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



mod store;

pub(crate) use store::SettingsStore;

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


mod errors;
#[cfg(test)]
mod mutation_tests;
#[cfg(test)]
mod tests;
mod validation;
