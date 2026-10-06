//! Bounded reads, serialization and private-permission helpers.
use super::*;
use serde::{Deserialize, Serialize};
pub(crate) use crate::private_fs::{open_private_file, read_bounded, set_private_directory_permissions, set_private_file_permissions};

pub(crate) fn canonicalize_supported_file(target: &str) -> Option<String> {
    let canonical = fs::canonicalize(target).ok()?;
    if !canonical.is_file() || WorkspaceFileKind::classify(&canonical).is_none() {
        return None;
    }
    canonical.to_str().map(str::to_string)
}


pub(crate) fn serialize_complete_store(store: &RecentFileStoreV1) -> Result<Vec<u8>, String> {
    if store.version != STORE_VERSION
        || store.entries.len() > MAX_RECENT_FILES
        || store.entries.iter().any(|entry| {
            !is_valid_opaque_id(&entry.id) || !valid_canonical_target(&entry.canonical_target)
        })
        || store.entries.iter().enumerate().any(|(index, entry)| {
            store.entries[..index].iter().any(|prior| {
                prior.id == entry.id || prior.canonical_target == entry.canonical_target
            })
        })
    {
        return Err("Recent files store is invalid".to_string());
    }
    let bytes = serde_json::to_vec(store)
        .map_err(|error| format!("Cannot serialize recent files: {error}"))?;
    if bytes.len() > MAX_STORE_BYTES {
        return Err("Recent files store exceeds its size limit".to_string());
    }
    Ok(bytes)
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RecentFileStoreV1 {
    pub(crate) version: u8,
    pub(crate) entries: Vec<RecentFileEntryV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RecentFileEntryV1 {
    pub(crate) id: String,
    #[serde(rename = "canonicalTarget")]
    pub(crate) canonical_target: String,
}
