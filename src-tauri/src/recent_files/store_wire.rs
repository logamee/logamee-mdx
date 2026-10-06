//! Store wire helpers and elapsed-time utilities.
use super::*;


pub(crate) fn elapsed_since(now: Duration, started_at: Duration) -> Duration {
    now.checked_sub(started_at).unwrap_or_default()
}

impl RecentFileEntryV1 {
    #[cfg(test)]
    pub(crate) fn new(id: impl Into<String>, canonical_target: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            canonical_target: canonical_target.into(),
        }
    }
}

impl RecentFileStoreV1 {
    pub(crate) fn empty() -> Self {
        Self {
            version: STORE_VERSION,
            entries: Vec::new(),
        }
    }

    pub(crate) fn promote(
        &mut self,
        canonical_target: String,
        next_id: &mut impl FnMut() -> Result<String, String>,
    ) -> Result<(), String> {
        if !valid_canonical_target(&canonical_target) {
            return Err("Recent file target is invalid".to_string());
        }

        let entry = if let Some(index) = self
            .entries
            .iter()
            .position(|entry| entry.canonical_target == canonical_target)
        {
            self.entries.remove(index)
        } else {
            let id = next_id()?;
            if !is_valid_opaque_id(&id) || self.entries.iter().any(|entry| entry.id == id) {
                return Err("Recent file identifier is invalid or duplicated".to_string());
            }
            RecentFileEntryV1 {
                id,
                canonical_target,
            }
        };

        self.entries.insert(0, entry);
        self.entries.truncate(MAX_RECENT_FILES);
        if serde_json::to_vec(self)
            .map_err(|error| format!("Cannot serialize recent files: {error}"))?
            .len()
            > MAX_STORE_BYTES
        {
            return Err("Recent files store exceeds its size limit".to_string());
        }
        Ok(())
    }

    pub(crate) fn snapshot(&self) -> Result<RecentFilesSnapshot, String> {
        let entries = self
            .entries
            .iter()
            .map(|entry| {
                let display_name = Path::new(&entry.canonical_target)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .ok_or_else(|| "Recent file has no displayable name".to_string())?;
                Ok(RecentFileSummary {
                    id: entry.id.clone(),
                    display_name: display_name.to_string(),
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok(RecentFilesSnapshot { entries })
    }
}

pub(crate) fn is_valid_opaque_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(crate) fn valid_canonical_target(target: &str) -> bool {
    !target.is_empty() && target.len() <= MAX_PATH_BYTES && Path::new(target).is_absolute()
}

pub(crate) fn repair_store_bytes(
    bytes: &[u8],
    mut canonicalize_supported_file: impl FnMut(&str) -> Option<String>,
) -> (RecentFileStoreV1, bool) {
    if bytes.len() > MAX_STORE_BYTES {
        return (RecentFileStoreV1::empty(), true);
    }

    let parsed = match serde_json::from_slice::<RecentFileStoreV1>(bytes) {
        Ok(store) if store.version == STORE_VERSION => store,
        _ => return (RecentFileStoreV1::empty(), true),
    };
    let original = parsed.clone();
    let mut repaired = RecentFileStoreV1::empty();
    let mut ids = HashSet::new();
    let mut targets = HashSet::new();

    for entry in parsed.entries {
        if repaired.entries.len() == MAX_RECENT_FILES
            || !is_valid_opaque_id(&entry.id)
            || !valid_canonical_target(&entry.canonical_target)
            || ids.contains(&entry.id)
        {
            continue;
        }
        let Some(canonical_target) = canonicalize_supported_file(&entry.canonical_target) else {
            continue;
        };
        if canonical_target != entry.canonical_target
            || !valid_canonical_target(&canonical_target)
            || targets.contains(&canonical_target)
        {
            continue;
        }

        let repaired_entry = RecentFileEntryV1 {
            id: entry.id.clone(),
            canonical_target: canonical_target.clone(),
        };
        repaired.entries.push(repaired_entry);
        if serde_json::to_vec(&repaired)
            .expect("recent V1 store serialization is infallible")
            .len()
            > MAX_STORE_BYTES
        {
            repaired.entries.pop();
            continue;
        }
        ids.insert(entry.id);
        targets.insert(canonical_target);
    }

    let changed = repaired != original;
    (repaired, changed)
}
