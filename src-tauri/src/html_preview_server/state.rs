//! Html preview server state operations.
use super::*;

impl HtmlPreviewServerState {
    pub(crate) fn lock_sites(&self) -> Result<HtmlPreviewSitesGuard<'_>, HtmlPreviewSitesRecoveryError> {
        let guard = match self.sites.lock() {
            Ok(guard) => guard,
            Err(poisoned) => {
                let guard = poisoned.into_inner();
                #[cfg(test)]
                let mut sites = HtmlPreviewSitesGuard::new(guard);
                #[cfg(not(test))]
                let mut sites = guard;
                let drained_leases = sites.drain_leases();
                drop(sites);
                self.sites.clear_poison();
                return Err(HtmlPreviewSitesRecoveryError { drained_leases });
            }
        };
        #[cfg(test)]
        {
            Ok(HtmlPreviewSitesGuard::new(guard))
        }
        #[cfg(not(test))]
        {
            Ok(guard)
        }
    }

    pub(crate) fn invalidate_preview_leases(
        &self,
        leases: &HashSet<PreviewLeaseId>,
    ) -> Result<(), HtmlPreviewSitesRecoveryError> {
        if leases.is_empty() {
            return Ok(());
        }
        let mut sites = self.lock_sites()?;
        sites.retain(|_, site| !leases.contains(&site.lease));
        sites.embeds.retain(|_, site| !leases.contains(&site.lease));
        sites.media.retain(|_, site| !leases.contains(&site.lease));
        Ok(())
    }

    pub(crate) fn remove_committed_generation(
        &self,
        document: &Path,
        active_lease: &PreviewLeaseId,
    ) -> Result<HashSet<PreviewLeaseId>, HtmlPreviewSitesRecoveryError> {
        let mut sites = self.lock_sites()?;
        if sites
            .get(document)
            .is_some_and(|site| &site.lease == active_lease)
        {
            return Ok(sites
                .remove(document)
                .map(|site| HashSet::from([site.lease.clone()]))
                .unwrap_or_default());
        }
        Ok(HashSet::new())
    }

    pub(crate) fn rollback_committed_embed_owner(
        &self,
        key: &HtmlEmbedSiteKey,
        owner_id: u64,
        active_lease: &PreviewLeaseId,
        remove_generation: bool,
    ) -> Result<HashSet<PreviewLeaseId>, HtmlPreviewSitesRecoveryError> {
        let mut sites = self.lock_sites()?;
        let should_remove = if let Some(site) = sites
            .embeds
            .get_mut(key)
            .filter(|site| &site.lease == active_lease)
        {
            if remove_generation {
                true
            } else {
                site.owners.remove(&owner_id);
                site.owners.is_empty()
            }
        } else {
            false
        };
        Ok(if should_remove {
            sites
                .embeds
                .remove(key)
                .map(|site| HashSet::from([site.lease.clone()]))
                .unwrap_or_default()
        } else {
            HashSet::new()
        })
    }

    pub(crate) fn rollback_committed_media_owner(
        &self,
        key: &MediaPreviewSiteKey,
        owner_id: u64,
        active_lease: &PreviewLeaseId,
        remove_generation: bool,
    ) -> Result<HashSet<PreviewLeaseId>, HtmlPreviewSitesRecoveryError> {
        let mut sites = self.lock_sites()?;
        let should_remove = if let Some(site) = sites
            .media
            .get_mut(key)
            .filter(|site| &site.lease == active_lease)
        {
            if remove_generation {
                true
            } else {
                site.owners.remove(&owner_id);
                site.owners.is_empty()
            }
        } else {
            false
        };
        Ok(if should_remove {
            sites
                .media
                .remove(key)
                .map(|site| HashSet::from([site.lease.clone()]))
                .unwrap_or_default()
        } else {
            HashSet::new()
        })
    }

    pub(crate) fn stop_all_sites(&self) -> Result<(), String> {
        self.lock_sites()
            .map_err(HtmlPreviewSitesRecoveryError::into_message)?
            .clear_all();
        Ok(())
    }

    pub(crate) fn start_site(
        &self,
        scope: AuthorizedPreviewScope,
        initial_content: String,
    ) -> Result<HtmlPreviewSite, String> {
        self.start_site_with_content(
            scope,
            HtmlPreviewContent::LiveDraft(Arc::new(Mutex::new(initial_content))),
        )
    }

    pub(crate) fn start_disk_site(&self, scope: AuthorizedPreviewScope) -> Result<HtmlPreviewSite, String> {
        self.start_site_with_content(scope, HtmlPreviewContent::Disk)
    }

    pub(crate) fn start_site_with_content(
        &self,
        scope: AuthorizedPreviewScope,
        content: HtmlPreviewContent,
    ) -> Result<HtmlPreviewSite, String> {
        #[cfg(test)]
        if let Some(error) = self
            .next_site_start_error
            .lock()
            .map_err(|_| "HTML preview site-start test seam is poisoned".to_string())?
            .take()
        {
            return Err(error);
        }

        HtmlPreviewSite::start(scope, content)
    }

    #[cfg(test)]
    pub(crate) fn fail_next_site_start(&self, error: impl Into<String>) -> Result<(), String> {
        *self
            .next_site_start_error
            .lock()
            .map_err(|_| "HTML preview site-start test seam is poisoned".to_string())? =
            Some(error.into());
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn site_documents(&self) -> Result<HashSet<PathBuf>, String> {
        Ok(self
            .lock_sites()
            .map_err(HtmlPreviewSitesRecoveryError::into_message)?
            .keys()
            .cloned()
            .collect())
    }

    #[cfg(test)]
    pub(crate) fn site_lease_snapshot(&self) -> Result<HashSet<PreviewLeaseId>, String> {
        let sites = self
            .lock_sites()
            .map_err(HtmlPreviewSitesRecoveryError::into_message)?;
        Ok(sites
            .values()
            .map(|site| site.lease.clone())
            .chain(sites.embeds.values().map(|site| site.lease.clone()))
            .collect())
    }

    #[cfg(test)]
    pub(crate) fn embed_stop_flag_for_test(
        &self,
        anchor: impl AsRef<Path>,
        document: impl AsRef<Path>,
    ) -> Result<Arc<AtomicBool>, String> {
        let key = HtmlEmbedSiteKey {
            anchor: normalize_existing_path(anchor)?,
            document: normalize_existing_path(document)?,
        };
        self.lock_sites()
            .map_err(HtmlPreviewSitesRecoveryError::into_message)?
            .embeds
            .get(&key)
            .map(|site| Arc::clone(&site.stop))
            .ok_or_else(|| "Embedded preview site is not active".to_string())
    }
}

pub(crate) fn encoded_relative_path(root: &Path, document: &Path) -> Result<String, String> {
    let relative = document
        .strip_prefix(root)
        .map_err(|_| "HTML preview file escaped its authorized root".to_string())?;
    relative
        .components()
        .map(|component| match component {
            Component::Normal(segment) => segment
                .to_str()
                .map(|segment| utf8_percent_encode(segment, NON_ALPHANUMERIC).to_string())
                .ok_or_else(|| "HTML preview path is not valid UTF-8".to_string()),
            _ => Err("HTML preview path is invalid".to_string()),
        })
        .collect::<Result<Vec<_>, _>>()
        .map(|segments| segments.join("/"))
}
pub(crate) fn new_media_access_token(document: &Path) -> Result<Option<String>, String> {
    if !matches!(
        WorkspaceFileKind::classify(document),
        Some(WorkspaceFileKind::Video | WorkspaceFileKind::Audio)
    ) {
        return Ok(None);
    }
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|error| format!("Cannot generate media access token: {error}"))?;
    Ok(Some(
        bytes.iter().map(|byte| format!("{byte:02x}")).collect(),
    ))
}
