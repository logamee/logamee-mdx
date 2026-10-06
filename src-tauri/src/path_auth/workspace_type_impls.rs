//! Per-type impls for workspace entities.
use super::*;

impl AuthorizedWorkspace {
    pub(crate) fn new(token: WorkspaceToken, root: PathBuf, root_binding: WorkspaceRootBinding) -> Self {
        Self {
            token,
            root,
            root_binding,
        }
    }

    #[cfg(test)]
    pub(crate) fn token(&self) -> &WorkspaceToken {
        &self.token
    }

    pub(crate) fn wire_token(&self) -> String {
        self.token.to_wire()
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn clone_root_handle(&self) -> std::io::Result<fs::File> {
        self.root_binding.handle.try_clone()
    }

    pub(crate) fn open_regular_file(&self, path: &Path) -> std::io::Result<fs::File> {
        let relative = path.strip_prefix(&self.root).map_err(|_| {
            std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "file is outside the authorized workspace root",
            )
        })?;
        self.root_binding.open_regular_file(relative)
    }

    #[cfg(test)]
    pub(crate) fn into_root(self) -> PathBuf {
        self.root
    }
}

impl AuthorizedReadFile {
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn into_parts(self) -> (PathBuf, fs::File) {
        (self.path, self.file)
    }

    pub(crate) fn workspace_authorization(&self) -> Option<&WorkspaceReadAuthorization> {
        self.workspace_authorization.as_ref()
    }
}

impl WorkspaceReadAuthorization {
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn wire_token(&self) -> String {
        self.token.to_wire()
    }

    pub(crate) fn retained_file_binding(&self) -> Arc<fs::File> {
        self.file_binding.clone()
    }
}

impl RenamedWorkspaceEntry {
    pub(crate) fn workspace(&self) -> &AuthorizedWorkspace {
        &self.workspace
    }

    pub(crate) fn old_path(&self) -> &Path {
        &self.old_path
    }

    pub(crate) fn new_path(&self) -> &Path {
        &self.new_path
    }

    pub(crate) fn is_file(&self) -> bool {
        self.is_file
    }
}

impl DeletedWorkspaceEntry {
    pub(crate) fn workspace(&self) -> &AuthorizedWorkspace {
        &self.workspace
    }

    pub(crate) fn deleted_path(&self) -> &Path {
        &self.deleted_path
    }

    #[cfg(test)]
    pub(crate) fn is_file(&self) -> bool {
        self.is_file
    }
}

impl CopiedWorkspaceEntry {
    pub(crate) fn workspace(&self) -> &AuthorizedWorkspace {
        &self.workspace
    }

    pub(crate) fn source(&self) -> &Path {
        &self.source
    }

    pub(crate) fn target(&self) -> &Path {
        &self.target
    }

    pub(crate) fn is_file(&self) -> bool {
        self.is_file
    }
}

impl WorkspaceToken {
    const WIRE_PREFIX: &'static str = "workspace-";
    const RECEIPT_PREFIX: &'static str = "workspace-open-";

    pub(crate) fn to_wire(self) -> String {
        format!("{}{id}", Self::WIRE_PREFIX, id = self.0)
    }

    pub(crate) fn from_wire(value: &str) -> Result<Self, String> {
        let id = value
            .strip_prefix(Self::WIRE_PREFIX)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| "Invalid workspace token".to_string())?
            .parse::<u64>()
            .map_err(|_| "Invalid workspace token".to_string())?;
        let token = Self(id);
        if token.to_wire() != value {
            return Err("Invalid workspace token".to_string());
        }
        Ok(token)
    }

    pub(crate) fn to_receipt(self) -> String {
        format!("{}{id}", Self::RECEIPT_PREFIX, id = self.0)
    }

    pub(crate) fn from_receipt(value: &str) -> Result<Self, String> {
        let id = value
            .strip_prefix(Self::RECEIPT_PREFIX)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| "Invalid workspace open receipt".to_string())?
            .parse::<u64>()
            .map_err(|_| "Invalid workspace open receipt".to_string())?;
        Ok(Self(id))
    }
}

impl AuthorizedFile {
    pub(crate) fn new(path: PathBuf, origin: GrantOrigin) -> Self {
        #[cfg(not(test))]
        let _ = &origin;
        Self {
            path,
            #[cfg(test)]
            origin,
        }
    }

    #[cfg(test)]
    pub(crate) fn origin(&self) -> &GrantOrigin {
        &self.origin
    }

    pub(crate) fn into_path(self) -> PathBuf {
        self.path
    }
}

impl AuthorizedPreviewScope {
    pub(crate) fn document(&self) -> &Path {
        &self.document
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn lease(&self) -> &PreviewLeaseId {
        &self.lease
    }

    pub(crate) fn into_parts(self) -> (PathBuf, PathBuf, PreviewLeaseId) {
        (self.document, self.root, self.lease)
    }
}

impl GrantKey {
    pub(crate) fn path(&self) -> &Path {
        match self {
            Self::ExactReadWrite(path) | Self::DirectoryRead(path) | Self::InternalAsset(path) => {
                path
            }
        }
    }

    pub(crate) fn relocated(self, old_prefix: &Path, new_prefix: &Path) -> Self {
        fn relocated_path(path: PathBuf, old_prefix: &Path, new_prefix: &Path) -> PathBuf {
            match path.strip_prefix(old_prefix) {
                Ok(suffix) => new_prefix.join(suffix),
                Err(_) => path,
            }
        }

        match self {
            Self::ExactReadWrite(path) => {
                Self::ExactReadWrite(relocated_path(path, old_prefix, new_prefix))
            }
            Self::DirectoryRead(path) => {
                Self::DirectoryRead(relocated_path(path, old_prefix, new_prefix))
            }
            Self::InternalAsset(path) => {
                Self::InternalAsset(relocated_path(path, old_prefix, new_prefix))
            }
        }
    }
}

impl GrantLedger {
    pub(crate) fn new(origin: GrantOrigin, first_granted_sequence: u64) -> Self {
        Self {
            origins: HashMap::from([(origin, 1)]),
            status: GrantStatus::Active,
            first_granted_sequence,
        }
    }

    pub(crate) fn try_new(origin: GrantOrigin, first_granted_sequence: u64) -> Result<Self, String> {
        let mut origins = HashMap::new();
        origins
            .try_reserve(1)
            .map_err(|_| "Cannot reserve document grant origin".to_string())?;
        origins.insert(origin, 1);
        Ok(Self {
            origins,
            status: GrantStatus::Active,
            first_granted_sequence,
        })
    }

    pub(crate) fn is_active(&self) -> bool {
        self.status == GrantStatus::Active && !self.origins.is_empty()
    }

    pub(crate) fn add_origin(&mut self, origin: GrantOrigin) {
        let count = self.origins.entry(origin).or_default();
        *count = count.saturating_add(1);
        self.status = GrantStatus::Active;
    }

    pub(crate) fn revoke_origin(&mut self, origin: &GrantOrigin, mode: RevokeOriginMode) {
        let remove = match (self.origins.get_mut(origin), mode) {
            (Some(_), RevokeOriginMode::All) => true,
            (None, _) => false,
        };
        if remove {
            self.origins.remove(origin);
        }
    }

    pub(crate) fn suspend(&mut self) {
        self.status = GrantStatus::Suspended;
    }

    pub(crate) fn merge(&mut self, other: Self) {
        match (self.status, other.status) {
            (GrantStatus::Suspended, GrantStatus::Active) => {
                *self = other;
                return;
            }
            (GrantStatus::Active, GrantStatus::Suspended) => return,
            _ => {}
        }
        self.first_granted_sequence = self
            .first_granted_sequence
            .min(other.first_granted_sequence);
        for (origin, count) in other.origins {
            let current = self.origins.entry(origin).or_default();
            *current = current.saturating_add(count);
        }
    }
}
