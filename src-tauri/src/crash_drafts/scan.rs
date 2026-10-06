//! Catalog scanning and entry classification.
use super::*;

pub(crate) struct ScannedCatalog<V> {
    pub(crate) entries: Vec<ScannedEntry<V>>,
    pub(crate) catalog_token: String,
}

pub(crate) enum ScannedEntry<V> {
    Supported {
        envelope: CrashDraftEnvelope,
        path: PathBuf,
        size: u64,
        token: String,
        version: V,
    },
    Protected {
        document_id: String,
        path: PathBuf,
        size: u64,
        token: String,
        version: V,
        reason: ProtectedDraftReason,
        future_schema_version: Option<u64>,
    },
}

impl<V> ScannedEntry<V> {
    pub(crate) fn id(&self) -> &str {
        match self {
            Self::Supported { envelope, .. } => &envelope.document_id,
            Self::Protected { document_id, .. } => document_id,
        }
    }

    pub(crate) fn path(&self) -> &Path {
        match self {
            Self::Supported { path, .. } | Self::Protected { path, .. } => path,
        }
    }

    pub(crate) fn size(&self) -> u64 {
        match self {
            Self::Supported { size, .. } | Self::Protected { size, .. } => *size,
        }
    }

    pub(crate) fn token(&self) -> &str {
        match self {
            Self::Supported { token, .. } | Self::Protected { token, .. } => token,
        }
    }

    pub(crate) fn version(&self) -> &V {
        match self {
            Self::Supported { version, .. } | Self::Protected { version, .. } => version,
        }
    }

    pub(crate) fn supported_envelope(&self) -> Option<&CrashDraftEnvelope> {
        match self {
            Self::Supported { envelope, .. } => Some(envelope),
            Self::Protected { .. } => None,
        }
    }

    pub(crate) fn eviction_key(&self) -> (u64, u64, &str) {
        match self {
            Self::Supported { envelope, .. } => (
                envelope.updated_at_ms,
                envelope.revision,
                envelope.document_id.as_str(),
            ),
            Self::Protected { document_id, .. } => (u64::MAX, u64::MAX, document_id),
        }
    }

    pub(crate) fn public(&self) -> CrashDraftListEntry {
        match self {
            Self::Supported {
                envelope,
                size,
                token,
                ..
            } => CrashDraftListEntry::Supported {
                draft: summary_from_supported(envelope, token, *size),
            },
            Self::Protected {
                document_id,
                size,
                token,
                reason,
                future_schema_version,
                ..
            } => CrashDraftListEntry::Protected {
                document_id: document_id.clone(),
                entry_token: token.clone(),
                reason: *reason,
                raw_size_bytes: *size,
                future_schema_version: *future_schema_version,
            },
        }
    }
}

impl<V> ScannedCatalog<V> {
    pub(crate) fn public(self) -> CrashDraftCatalog {
        CrashDraftCatalog {
            entries: self.entries.iter().map(ScannedEntry::public).collect(),
            catalog_token: self.catalog_token,
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn classify_entry<V>(
    filename_id: String,
    path: PathBuf,
    bytes: Vec<u8>,
    size: u64,
    token: String,
    version: V,
    oversized: bool,
) -> ScannedEntry<V> {
    if oversized {
        return ScannedEntry::Protected {
            document_id: filename_id,
            path,
            size,
            token,
            version,
            reason: ProtectedDraftReason::Oversized,
            future_schema_version: None,
        };
    }
    let detected_schema_version = serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok()
        .and_then(|value| {
            value
                .get("schemaVersion")
                .and_then(serde_json::Value::as_u64)
        });
    let future_schema_version =
        detected_schema_version.filter(|schema| *schema > u64::from(CRASH_DRAFT_SCHEMA_VERSION));
    if let Ok(envelope) = serde_json::from_slice::<CrashDraftEnvelope>(&bytes) {
        if validate_envelope(&envelope, &filename_id).is_ok() {
            return ScannedEntry::Supported {
                envelope,
                path,
                size,
                token,
                version,
            };
        }
    }
    ScannedEntry::Protected {
        document_id: filename_id,
        path,
        size,
        token,
        version,
        reason: if future_schema_version.is_some() {
            ProtectedDraftReason::UnsupportedSchema
        } else {
            ProtectedDraftReason::Corrupt
        },
        future_schema_version,
    }
}
