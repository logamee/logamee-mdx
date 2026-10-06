//! Preview site types, keys and commits.
use super::*;


pub(crate) struct HtmlPreviewSite {
    pub(crate) url: String,
    pub(crate) root: PathBuf,
    pub(crate) content: HtmlPreviewContent,
    pub(crate) server: Arc<Server>,
    pub(crate) stop: Arc<AtomicBool>,
    pub(crate) lease: PreviewLeaseId,
}

pub(crate) struct EmbeddedPreviewSite {
    pub(crate) site: HtmlPreviewSite,
    pub(crate) owners: HashMap<u64, String>,
}

impl EmbeddedPreviewSite {
    pub(crate) fn new(site: HtmlPreviewSite, owner_id: u64, owner_window: &str) -> Self {
        Self {
            site,
            owners: HashMap::from([(owner_id, owner_window.to_string())]),
        }
    }
}

impl Deref for EmbeddedPreviewSite {
    type Target = HtmlPreviewSite;

    fn deref(&self) -> &Self::Target {
        &self.site
    }
}

impl DerefMut for EmbeddedPreviewSite {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.site
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MarkdownHtmlEmbedHandle {
    pub(crate) url: String,
    pub(crate) owner_id: u64,
}

#[derive(Clone)]
pub(crate) enum HtmlPreviewContent {
    LiveDraft(Arc<Mutex<String>>),
    Disk,
}

#[cfg(test)]
impl HtmlPreviewContent {
    pub(crate) fn shares_state_with(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::LiveDraft(left), Self::LiveDraft(right)) => Arc::ptr_eq(left, right),
            (Self::Disk, Self::Disk) => true,
            _ => false,
        }
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) struct HtmlEmbedSiteKey {
    pub(crate) anchor: PathBuf,
    pub(crate) document: PathBuf,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) struct MediaPreviewSiteKey(pub(crate) PathBuf);

#[derive(Default)]
pub(crate) struct HtmlPreviewSites {
    pub(crate) drafts: HashMap<PathBuf, HtmlPreviewSite>,
    pub(crate) embeds: HashMap<HtmlEmbedSiteKey, EmbeddedPreviewSite>,
    pub(crate) media: HashMap<MediaPreviewSiteKey, EmbeddedPreviewSite>,
    pub(crate) next_embed_owner_id: u64,
}

impl HtmlPreviewSites {
    pub(crate) fn len_all(&self) -> usize {
        self.drafts.len() + self.embeds.len() + self.media.len()
    }

    pub(crate) fn clear_all(&mut self) {
        self.drafts.clear();
        self.embeds.clear();
        self.media.clear();
    }

    pub(crate) fn drain_leases(&mut self) -> HashSet<PreviewLeaseId> {
        self.drafts
            .drain()
            .map(|(_, site)| site.lease.clone())
            .chain(self.embeds.drain().map(|(_, site)| site.lease.clone()))
            .chain(self.media.drain().map(|(_, site)| site.lease.clone()))
            .collect()
    }

    pub(crate) fn allocate_embed_owner_id(&mut self) -> Result<u64, String> {
        let owner_id = self.next_embed_owner_id;
        if owner_id > MAX_EMBED_OWNER_ID {
            return Err("HTML embed owner identifier space is exhausted".to_string());
        }
        self.next_embed_owner_id = owner_id
            .checked_add(1)
            .ok_or_else(|| "HTML embed owner identifier space is exhausted".to_string())?;
        Ok(owner_id)
    }
}

impl Deref for HtmlPreviewSites {
    type Target = HashMap<PathBuf, HtmlPreviewSite>;

    fn deref(&self) -> &Self::Target {
        &self.drafts
    }
}

impl DerefMut for HtmlPreviewSites {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.drafts
    }
}

pub(crate) struct HtmlPreviewCommit {
    pub(crate) document: PathBuf,
    pub(crate) url: String,
    pub(crate) active_lease: PreviewLeaseId,
    pub(crate) retired_leases: HashSet<PreviewLeaseId>,
}

pub(crate) struct MediaPreviewCommit {
    pub(crate) key: MediaPreviewSiteKey,
    pub(crate) url: String,
    pub(crate) owner_id: u64,
    pub(crate) active_lease: PreviewLeaseId,
    pub(crate) retired_leases: HashSet<PreviewLeaseId>,
}

pub(crate) struct HtmlEmbedPreviewCommit {
    pub(crate) key: HtmlEmbedSiteKey,
    pub(crate) url: String,
    pub(crate) owner_id: u64,
    pub(crate) active_lease: PreviewLeaseId,
    pub(crate) retired_leases: HashSet<PreviewLeaseId>,
}

pub(crate) enum HtmlPreviewSiteTransactionError {
    Operation(String),
    SitesRecovery(HtmlPreviewSitesRecoveryError),
}

#[derive(Debug)]
pub(crate) struct HtmlPreviewSitesRecoveryError {
    pub(crate) drained_leases: HashSet<PreviewLeaseId>,
}

impl HtmlPreviewSitesRecoveryError {
    pub(crate) fn into_parts(self) -> (String, HashSet<PreviewLeaseId>) {
        (
            POISONED_PREVIEW_SITES_ERROR.to_string(),
            self.drained_leases,
        )
    }

    pub(crate) fn into_message(self) -> String {
        self.into_parts().0
    }
}


#[derive(Default)]
pub(crate) struct HtmlPreviewServerState {
    pub(crate) sites: Mutex<HtmlPreviewSites>,
    #[cfg(test)]
    pub(crate) next_site_start_error: Mutex<Option<String>>,
}

#[cfg(test)]
pub(crate) struct HtmlPreviewSitesGuard<'a> {
    pub(crate) inner: Option<MutexGuard<'a, HtmlPreviewSites>>,
}

#[cfg(not(test))]
#[cfg(not(test))]
pub(crate) type HtmlPreviewSitesGuard<'a> = MutexGuard<'a, HtmlPreviewSites>;

#[cfg(test)]
impl<'a> HtmlPreviewSitesGuard<'a> {
    pub(crate) fn new(inner: MutexGuard<'a, HtmlPreviewSites>) -> Self {
        crate::path_auth::lock_order_test_probe::html_sites_acquired();
        Self { inner: Some(inner) }
    }
}

#[cfg(test)]
impl Deref for HtmlPreviewSitesGuard<'_> {
    type Target = HtmlPreviewSites;

    fn deref(&self) -> &Self::Target {
        self.inner.as_deref().expect("HTML sites guard is active")
    }
}

#[cfg(test)]
impl DerefMut for HtmlPreviewSitesGuard<'_> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.inner
            .as_deref_mut()
            .expect("HTML sites guard is active")
    }
}

#[cfg(test)]
impl Drop for HtmlPreviewSitesGuard<'_> {
    fn drop(&mut self) {
        self.inner.take();
        crate::path_auth::lock_order_test_probe::html_sites_released();
    }
}
