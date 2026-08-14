use std::{
    collections::{HashMap, HashSet},
    fs::File,
    io::{self, Read, Seek, SeekFrom},
    ops::{Deref, DerefMut},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, MutexGuard,
    },
    thread,
    time::Duration,
};

use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use serde::Serialize;
use tauri::State;
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

use crate::{
    path_auth::{
        normalize_existing_path, path_is_under, preview_lease_support_statuses_inner,
        preview_scope_for_anchored_file_with_root_inner, preview_scope_for_file_inner,
        retire_preview_lease_inner, retire_preview_leases_inner, AuthorizedPreviewScope,
        PreviewLeaseId, PreviewRetirementError,
    },
    state::AppState,
    workspace_file_kind::WorkspaceFileKind,
};

const PREVIEW_WORKERS: usize = 4;
const MAX_PREVIEW_SITES: usize = 8;
const MAX_EMBED_OWNER_ID: u64 = 9_007_199_254_740_991;
const POISONED_PREVIEW_SITES_ERROR: &str =
    "HTML preview server state was poisoned; all preview sites were stopped";
const PREVIEW_AUTHORIZATION_CHANGED_ERROR: &str =
    "HTML preview authorization changed before the site was committed";

#[cfg(test)]
mod site_start_test_probe {
    use std::cell::RefCell;

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub(super) enum Event {
        LoopbackBindAttempted,
        WorkerSpawnAttempted,
    }

    thread_local! {
        static TRACE: RefCell<Option<Vec<Event>>> = const { RefCell::new(None) };
    }

    pub(super) fn trace<T>(operation: impl FnOnce() -> T) -> (T, Vec<Event>) {
        TRACE.with(|trace| {
            assert!(
                trace.borrow().is_none(),
                "site-start traces cannot be nested"
            );
            *trace.borrow_mut() = Some(Vec::new());
        });
        let result = operation();
        let events = TRACE.with(|trace| {
            trace
                .borrow_mut()
                .take()
                .expect("site-start trace is active")
        });
        (result, events)
    }

    fn record(event: Event) {
        TRACE.with(|trace| {
            if let Some(events) = trace.borrow_mut().as_mut() {
                events.push(event);
            }
        });
    }

    pub(super) fn loopback_bind_attempted() {
        record(Event::LoopbackBindAttempted);
    }

    pub(super) fn worker_spawn_attempted() {
        record(Event::WorkerSpawnAttempted);
    }
}

#[cfg(test)]
mod preview_commit_test_probe {
    use std::cell::RefCell;

    use crate::path_auth::PreviewLeaseId;
    use crate::state::AppState;

    type BeforeCommitOperation = Box<dyn FnOnce(&AppState, &PreviewLeaseId)>;

    thread_local! {
        static BEFORE_COMMIT: RefCell<Option<BeforeCommitOperation>> = RefCell::new(None);
    }

    pub(super) fn before_next_commit(operation: impl FnOnce(&AppState, &PreviewLeaseId) + 'static) {
        BEFORE_COMMIT.with(|pending| {
            assert!(
                pending.borrow().is_none(),
                "preview pre-commit operations cannot be nested"
            );
            *pending.borrow_mut() = Some(Box::new(operation));
        });
    }

    pub(super) fn run(state: &AppState, lease: &PreviewLeaseId) {
        let operation = BEFORE_COMMIT.with(|pending| pending.borrow_mut().take());
        if let Some(operation) = operation {
            operation(state, lease);
        }
    }
}

struct HtmlPreviewSite {
    url: String,
    root: PathBuf,
    content: HtmlPreviewContent,
    server: Arc<Server>,
    stop: Arc<AtomicBool>,
    lease: PreviewLeaseId,
}

struct EmbeddedPreviewSite {
    site: HtmlPreviewSite,
    owners: HashMap<u64, String>,
}

impl EmbeddedPreviewSite {
    fn new(site: HtmlPreviewSite, owner_id: u64, owner_window: &str) -> Self {
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
    url: String,
    owner_id: u64,
}

#[derive(Clone)]
enum HtmlPreviewContent {
    LiveDraft(Arc<Mutex<String>>),
    Disk,
}

#[cfg(test)]
impl HtmlPreviewContent {
    fn shares_state_with(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::LiveDraft(left), Self::LiveDraft(right)) => Arc::ptr_eq(left, right),
            (Self::Disk, Self::Disk) => true,
            _ => false,
        }
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct HtmlEmbedSiteKey {
    anchor: PathBuf,
    document: PathBuf,
}

#[derive(Default)]
struct HtmlPreviewSites {
    drafts: HashMap<PathBuf, HtmlPreviewSite>,
    embeds: HashMap<HtmlEmbedSiteKey, EmbeddedPreviewSite>,
    next_embed_owner_id: u64,
}

impl HtmlPreviewSites {
    fn len_all(&self) -> usize {
        self.drafts.len() + self.embeds.len()
    }

    fn clear_all(&mut self) {
        self.drafts.clear();
        self.embeds.clear();
    }

    fn drain_leases(&mut self) -> HashSet<PreviewLeaseId> {
        self.drafts
            .drain()
            .map(|(_, site)| site.lease.clone())
            .chain(self.embeds.drain().map(|(_, site)| site.lease.clone()))
            .collect()
    }

    fn allocate_embed_owner_id(&mut self) -> Result<u64, String> {
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

struct HtmlPreviewCommit {
    document: PathBuf,
    url: String,
    active_lease: PreviewLeaseId,
    retired_leases: HashSet<PreviewLeaseId>,
}

struct HtmlEmbedPreviewCommit {
    key: HtmlEmbedSiteKey,
    url: String,
    owner_id: u64,
    active_lease: PreviewLeaseId,
    retired_leases: HashSet<PreviewLeaseId>,
}

enum HtmlPreviewSiteTransactionError {
    Operation(String),
    SitesRecovery(HtmlPreviewSitesRecoveryError),
}

#[derive(Debug)]
pub(crate) struct HtmlPreviewSitesRecoveryError {
    drained_leases: HashSet<PreviewLeaseId>,
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
    sites: Mutex<HtmlPreviewSites>,
    #[cfg(test)]
    next_site_start_error: Mutex<Option<String>>,
}

#[cfg(test)]
struct HtmlPreviewSitesGuard<'a> {
    inner: Option<MutexGuard<'a, HtmlPreviewSites>>,
}

#[cfg(not(test))]
type HtmlPreviewSitesGuard<'a> = MutexGuard<'a, HtmlPreviewSites>;

#[cfg(test)]
impl<'a> HtmlPreviewSitesGuard<'a> {
    fn new(inner: MutexGuard<'a, HtmlPreviewSites>) -> Self {
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

impl HtmlPreviewServerState {
    fn lock_sites(&self) -> Result<HtmlPreviewSitesGuard<'_>, HtmlPreviewSitesRecoveryError> {
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
        Ok(())
    }

    fn remove_committed_generation(
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

    fn rollback_committed_embed_owner(
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

    pub(crate) fn stop_all_sites(&self) -> Result<(), String> {
        self.lock_sites()
            .map_err(HtmlPreviewSitesRecoveryError::into_message)?
            .clear_all();
        Ok(())
    }

    fn start_site(
        &self,
        scope: AuthorizedPreviewScope,
        initial_content: String,
    ) -> Result<HtmlPreviewSite, String> {
        self.start_site_with_content(
            scope,
            HtmlPreviewContent::LiveDraft(Arc::new(Mutex::new(initial_content))),
        )
    }

    fn start_disk_site(&self, scope: AuthorizedPreviewScope) -> Result<HtmlPreviewSite, String> {
        self.start_site_with_content(scope, HtmlPreviewContent::Disk)
    }

    fn start_site_with_content(
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
    fn fail_next_site_start(&self, error: impl Into<String>) -> Result<(), String> {
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
    fn site_lease_snapshot(&self) -> Result<HashSet<PreviewLeaseId>, String> {
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
    fn embed_stop_flag_for_test(
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

fn header(name: &[u8], value: impl AsRef<[u8]>) -> Header {
    Header::from_bytes(name, value.as_ref()).expect("static preview response header is valid")
}

fn respond_bytes(request: Request, status: u16, mime_type: &str, body: Vec<u8>) {
    let length = body.len();
    let response = Response::new(
        StatusCode(status),
        vec![
            header(b"Content-Type", mime_type),
            header(b"Cache-Control", b"no-store"),
            header(b"X-Content-Type-Options", b"nosniff"),
        ],
        std::io::Cursor::new(body),
        Some(length),
        None,
    );
    let _ = request.respond(response);
}

fn requested_byte_range(request: &Request, length: usize) -> Result<Option<(usize, usize)>, ()> {
    let Some(value) = request
        .headers()
        .iter()
        .find(|header| header.field.equiv("Range"))
        .map(|header| header.value.as_str())
    else {
        return Ok(None);
    };
    let Some(range) = value.strip_prefix("bytes=") else {
        return Err(());
    };
    if length == 0 || range.contains(',') {
        return Err(());
    }
    let (start, end) = range.split_once('-').ok_or(())?;
    if start.is_empty() {
        let suffix = end.parse::<usize>().map_err(|_| ())?;
        if suffix == 0 {
            return Err(());
        }
        let start = length.saturating_sub(suffix);
        return Ok(Some((start, length - 1)));
    }
    let start = start.parse::<usize>().map_err(|_| ())?;
    if start >= length {
        return Err(());
    }
    let end = if end.is_empty() {
        length - 1
    } else {
        end.parse::<usize>().map_err(|_| ())?.min(length - 1)
    };
    if end < start {
        return Err(());
    }
    Ok(Some((start, end)))
}

fn respond_file(request: Request, mime_type: &str, mut file: File, length: usize) {
    match requested_byte_range(&request, length) {
        Ok(Some((start, end))) => {
            if file.seek(SeekFrom::Start(start as u64)).is_err() {
                respond_bytes(
                    request,
                    404,
                    "text/plain; charset=utf-8",
                    b"Not found".to_vec(),
                );
                return;
            }
            let range_length = end - start + 1;
            let response = Response::new(
                StatusCode(206),
                vec![
                    header(b"Content-Type", mime_type),
                    header(b"Content-Range", format!("bytes {start}-{end}/{length}")),
                    header(b"Accept-Ranges", b"bytes"),
                    header(b"Cache-Control", b"no-store"),
                    header(b"X-Content-Type-Options", b"nosniff"),
                ],
                file.take(range_length as u64),
                Some(range_length),
                None,
            );
            let _ = request.respond(response);
        }
        Ok(None) => {
            let response = Response::new(
                StatusCode(200),
                vec![
                    header(b"Content-Type", mime_type),
                    header(b"Accept-Ranges", b"bytes"),
                    header(b"Cache-Control", b"no-store"),
                    header(b"X-Content-Type-Options", b"nosniff"),
                ],
                file,
                Some(length),
                None,
            );
            let _ = request.respond(response);
        }
        Err(()) => {
            let response = Response::new(
                StatusCode(416),
                vec![
                    header(b"Content-Type", b"text/plain; charset=utf-8"),
                    header(b"Content-Range", format!("bytes */{length}")),
                    header(b"Cache-Control", b"no-store"),
                    header(b"X-Content-Type-Options", b"nosniff"),
                ],
                std::io::Cursor::new(Vec::new()),
                Some(0),
                None,
            );
            let _ = request.respond(response);
        }
    }
}

fn request_is_local(request: &Request, authority: &str) -> bool {
    let local_client = request
        .remote_addr()
        .is_some_and(|address| address.ip().is_loopback());
    let valid_host = request
        .headers()
        .iter()
        .find(|header| header.field.equiv("Host"))
        .is_some_and(|header| header.value.as_str() == authority);
    local_client && valid_host
}

#[cfg(target_os = "macos")]
fn opened_file_path(file: &File) -> io::Result<PathBuf> {
    use std::{
        ffi::CStr,
        os::{fd::AsRawFd, unix::ffi::OsStringExt},
    };

    const F_GETPATH: std::ffi::c_int = 50;
    const PATH_BUFFER_SIZE: usize = 4096;

    unsafe extern "C" {
        fn fcntl(fd: std::ffi::c_int, command: std::ffi::c_int, ...) -> std::ffi::c_int;
    }

    let mut path = [0_u8; PATH_BUFFER_SIZE];
    if unsafe { fcntl(file.as_raw_fd(), F_GETPATH, path.as_mut_ptr()) } == -1 {
        return Err(io::Error::last_os_error());
    }
    let path = CStr::from_bytes_until_nul(&path)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "opened path is not terminated"))?;
    Ok(PathBuf::from(std::ffi::OsString::from_vec(
        path.to_bytes().to_vec(),
    )))
}

#[cfg(target_os = "linux")]
fn opened_file_path(file: &File) -> io::Result<PathBuf> {
    use std::os::fd::AsRawFd;

    std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd()))
}

#[cfg(windows)]
fn opened_file_path(file: &File) -> io::Result<PathBuf> {
    use std::{
        ffi::OsString,
        os::windows::{ffi::OsStringExt, io::AsRawHandle},
        ptr::null_mut,
    };
    use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;

    let handle = file.as_raw_handle() as windows_sys::Win32::Foundation::HANDLE;
    let required = unsafe { GetFinalPathNameByHandleW(handle, null_mut(), 0, 0) };
    if required == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut buffer = vec![0_u16; required as usize + 1];
    let written =
        unsafe { GetFinalPathNameByHandleW(handle, buffer.as_mut_ptr(), buffer.len() as u32, 0) };
    if written == 0 {
        return Err(io::Error::last_os_error());
    }
    if written as usize >= buffer.len() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "opened path changed while it was queried",
        ));
    }
    buffer.truncate(written as usize);
    Ok(PathBuf::from(OsString::from_wide(&buffer)))
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn opened_file_path(_file: &File) -> io::Result<PathBuf> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "opened-file path verification is unavailable on this platform",
    ))
}

fn open_authorized_file_with(
    requested: &Path,
    root: &Path,
    after_open: impl FnOnce(),
    after_opened_path: impl FnOnce(),
) -> io::Result<(File, std::fs::Metadata, PathBuf)> {
    let file = File::open(requested)?;
    after_open();
    let opened_path = opened_file_path(&file)?;
    after_opened_path();
    let canonical = normalize_existing_path(&opened_path)
        .map_err(|error| io::Error::new(io::ErrorKind::PermissionDenied, error))?;
    let retained_path = opened_file_path(&file)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || retained_path != canonical || !path_is_under(&canonical, root) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "opened preview file escaped its authorized root",
        ));
    }
    Ok((file, metadata, canonical))
}

fn open_authorized_file(
    requested: &Path,
    root: &Path,
) -> io::Result<(File, std::fs::Metadata, PathBuf)> {
    open_authorized_file_with(requested, root, || {}, || {})
}

fn route_request(
    request: Request,
    authority: &str,
    root: &Path,
    document: &Path,
    content: &HtmlPreviewContent,
) {
    if !request_is_local(&request, authority) {
        respond_bytes(
            request,
            421,
            "text/plain; charset=utf-8",
            b"Misdirected request".to_vec(),
        );
        return;
    }
    if !matches!(request.method(), Method::Get | Method::Head) {
        let response = Response::new(
            StatusCode(405),
            vec![
                header(b"Content-Type", b"text/plain; charset=utf-8"),
                header(b"Allow", b"GET, HEAD"),
                header(b"Cache-Control", b"no-store"),
                header(b"X-Content-Type-Options", b"nosniff"),
            ],
            std::io::Cursor::new(b"Method not allowed".to_vec()),
            Some(18),
            None,
        );
        let _ = request.respond(response);
        return;
    }

    let encoded_path = request.url().split('?').next().unwrap_or_default();
    let Ok(decoded_path) = percent_decode_str(encoded_path).decode_utf8() else {
        respond_bytes(
            request,
            400,
            "text/plain; charset=utf-8",
            b"Invalid path".to_vec(),
        );
        return;
    };
    let relative_path = decoded_path.trim_start_matches('/');
    if relative_path.is_empty() {
        respond_bytes(
            request,
            404,
            "text/plain; charset=utf-8",
            b"Not found".to_vec(),
        );
        return;
    }
    let relative = Path::new(relative_path);
    if relative
        .components()
        .any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
    {
        respond_bytes(
            request,
            403,
            "text/plain; charset=utf-8",
            b"Forbidden".to_vec(),
        );
        return;
    }
    let requested = root.join(relative);
    let (file, metadata, canonical) = match open_authorized_file(&requested, root) {
        Ok(opened) => opened,
        _ => {
            respond_bytes(
                request,
                404,
                "text/plain; charset=utf-8",
                b"Not found".to_vec(),
            );
            return;
        }
    };

    if canonical == document {
        if let HtmlPreviewContent::LiveDraft(content) = content {
            let live_content = match content.lock() {
                Ok(content) => content.clone(),
                Err(_) => {
                    respond_bytes(
                        request,
                        500,
                        "text/plain; charset=utf-8",
                        b"Preview unavailable".to_vec(),
                    );
                    return;
                }
            };
            respond_bytes(
                request,
                200,
                "text/html; charset=utf-8",
                live_content.into_bytes(),
            );
            return;
        }
    }

    let mime = mime_guess::from_path(&canonical).first_or_octet_stream();
    respond_file(request, mime.as_ref(), file, metadata.len() as usize);
}

fn encoded_relative_path(root: &Path, document: &Path) -> Result<String, String> {
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

impl HtmlPreviewSite {
    fn start(scope: AuthorizedPreviewScope, content: HtmlPreviewContent) -> Result<Self, String> {
        let (document, root, lease) = scope.into_parts();
        Self::start_parts(document, root, lease, content)
    }

    fn start_parts(
        document: PathBuf,
        root: PathBuf,
        lease: PreviewLeaseId,
        content: HtmlPreviewContent,
    ) -> Result<Self, String> {
        let encoded_path = encoded_relative_path(&root, &document)?;
        #[cfg(test)]
        site_start_test_probe::loopback_bind_attempted();
        let server = Arc::new(
            Server::http("127.0.0.1:0")
                .map_err(|err| format!("Failed to start HTML preview server: {err}"))?,
        );
        let address = server
            .server_addr()
            .to_ip()
            .ok_or_else(|| "HTML preview server did not bind to an IP address".to_string())?;
        let authority = address.to_string();
        let stop = Arc::new(AtomicBool::new(false));

        for worker_index in 0..PREVIEW_WORKERS {
            let worker_server = Arc::clone(&server);
            let worker_root = root.clone();
            let worker_document = document.clone();
            let worker_content = content.clone();
            let worker_stop = Arc::clone(&stop);
            let worker_authority = authority.clone();
            let worker_builder =
                thread::Builder::new().name(format!("mmd-html-preview-{worker_index}"));
            #[cfg(test)]
            site_start_test_probe::worker_spawn_attempted();
            let spawn_result = worker_builder.spawn(move || {
                while !worker_stop.load(Ordering::Acquire) {
                    match worker_server.recv_timeout(Duration::from_millis(250)) {
                        Ok(Some(request)) => route_request(
                            request,
                            &worker_authority,
                            &worker_root,
                            &worker_document,
                            &worker_content,
                        ),
                        Ok(None) => {}
                        Err(_) if worker_stop.load(Ordering::Acquire) => break,
                        Err(_) => {}
                    }
                }
            });
            if let Err(err) = spawn_result {
                stop.store(true, Ordering::Release);
                for _ in 0..PREVIEW_WORKERS {
                    server.unblock();
                }
                return Err(format!("Failed to run HTML preview server: {err}"));
            }
        }

        Ok(Self {
            url: format!("http://{address}/{encoded_path}"),
            root,
            content,
            server,
            stop,
            lease,
        })
    }

    fn update(
        &mut self,
        content: &str,
        lease: PreviewLeaseId,
    ) -> Result<(String, PreviewLeaseId), String> {
        let HtmlPreviewContent::LiveDraft(live_content) = &self.content else {
            return Err("Disk-backed HTML preview cannot be updated in memory".to_string());
        };
        *live_content
            .lock()
            .map_err(|_| "HTML preview state is poisoned".to_string())? = content.to_string();
        Ok(self.replace_lease(lease))
    }

    fn replace_lease(&mut self, lease: PreviewLeaseId) -> (String, PreviewLeaseId) {
        let retired_lease = std::mem::replace(&mut self.lease, lease);
        (self.url.clone(), retired_lease)
    }
}

impl Drop for HtmlPreviewSite {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        for _ in 0..PREVIEW_WORKERS {
            self.server.unblock();
        }
    }
}

fn retire_rollback_leases(
    state: &AppState,
    leases: &HashSet<PreviewLeaseId>,
) -> Result<(), String> {
    match retire_preview_leases_inner(state, leases) {
        Ok(()) => Ok(()),
        Err(PreviewRetirementError::AuthorizationUnavailable(error)) => {
            let _ = state.html_preview_server.stop_all_sites();
            Err(error)
        }
        #[cfg(test)]
        Err(PreviewRetirementError::Recoverable(error)) => {
            retire_preview_leases_inner(state, leases)
                .map_err(PreviewRetirementError::into_message)?;
            Err(error)
        }
    }
}

pub(crate) fn prepare_html_preview_inner(
    state: &AppState,
    path: impl AsRef<Path>,
    content: &str,
) -> Result<String, String> {
    let path = path.as_ref().to_path_buf();
    let scope = preview_scope_for_file_inner(state, path)?;
    prepare_html_preview_with_scope_inner(state, scope, content)
}

fn prepare_html_preview_with_scope_inner(
    state: &AppState,
    scope: AuthorizedPreviewScope,
    content: &str,
) -> Result<String, String> {
    let reserved_lease = scope.lease().clone();
    let active_lease = reserved_lease.clone();
    let document = scope.document().to_path_buf();
    #[cfg(test)]
    preview_commit_test_probe::run(state, &reserved_lease);
    let site_transaction: Result<HtmlPreviewCommit, HtmlPreviewSiteTransactionError> = (|| {
        if WorkspaceFileKind::classify(scope.document()) != Some(WorkspaceFileKind::Html) {
            return Err(HtmlPreviewSiteTransactionError::Operation(
                "HTML preview requires an HTML file".into(),
            ));
        }
        let mut sites = state
            .html_preview_server
            .lock_sites()
            .map_err(HtmlPreviewSiteTransactionError::SitesRecovery)?;
        let root_changed = sites
            .get(&document)
            .is_some_and(|site| site.root.as_path() != scope.root());
        let (url, retired_lease) = if root_changed {
            let replacement = state
                .html_preview_server
                .start_site(scope, content.to_string())
                .map_err(HtmlPreviewSiteTransactionError::Operation)?;
            let url = replacement.url.clone();
            let replaced = sites
                .insert(document.clone(), replacement)
                .expect("root comparison found an existing preview site");
            let retired_lease = replaced.lease.clone();
            drop(replaced);
            (url, Some(retired_lease))
        } else if let Some(site) = sites.get_mut(&document) {
            let (_, _, lease) = scope.into_parts();
            let (url, retired_lease) = site
                .update(content, lease)
                .map_err(HtmlPreviewSiteTransactionError::Operation)?;
            (url, Some(retired_lease))
        } else {
            if sites.len_all() >= MAX_PREVIEW_SITES {
                return Err(HtmlPreviewSiteTransactionError::Operation(
                    "Too many active HTML preview sites".to_string(),
                ));
            }
            let site = state
                .html_preview_server
                .start_site(scope, content.to_string())
                .map_err(HtmlPreviewSiteTransactionError::Operation)?;
            let url = site.url.clone();
            sites.insert(document.clone(), site);
            (url, None)
        };
        Ok(HtmlPreviewCommit {
            document,
            url,
            active_lease,
            retired_leases: retired_lease.into_iter().collect(),
        })
    })();
    let commit = match site_transaction {
        Ok(committed) => committed,
        Err(HtmlPreviewSiteTransactionError::Operation(error)) => {
            match retire_preview_lease_inner(state, &reserved_lease) {
                Ok(()) => return Err(error),
                Err(PreviewRetirementError::AuthorizationUnavailable(error)) => {
                    let _ = state.html_preview_server.stop_all_sites();
                    return Err(error);
                }
                #[cfg(test)]
                Err(PreviewRetirementError::Recoverable(error)) => return Err(error),
            }
        }
        Err(HtmlPreviewSiteTransactionError::SitesRecovery(recovery)) => {
            let (error, mut rollback_leases) = recovery.into_parts();
            rollback_leases.insert(reserved_lease.clone());
            match retire_preview_leases_inner(state, &rollback_leases) {
                Ok(()) => return Err(error),
                Err(PreviewRetirementError::AuthorizationUnavailable(error)) => {
                    let _ = state.html_preview_server.stop_all_sites();
                    return Err(error);
                }
                #[cfg(test)]
                Err(PreviewRetirementError::Recoverable(error)) => return Err(error),
            }
        }
    };
    let HtmlPreviewCommit {
        document: _document,
        url,
        active_lease: _active_lease,
        retired_leases,
    } = commit;
    let lease_is_valid = match preview_lease_support_statuses_inner(state, &[&_active_lease]) {
        Ok(statuses) => statuses[0],
        Err(error) => {
            let _ = state.html_preview_server.stop_all_sites();
            return Err(error);
        }
    };
    if !lease_is_valid {
        let mut rollback_leases = retired_leases;
        rollback_leases.insert(_active_lease.clone());
        let rollback_error = match state
            .html_preview_server
            .remove_committed_generation(&_document, &_active_lease)
        {
            Ok(removed_leases) => {
                rollback_leases.extend(removed_leases);
                None
            }
            Err(recovery) => {
                let (error, drained_leases) = recovery.into_parts();
                rollback_leases.extend(drained_leases);
                Some(error)
            }
        };
        retire_rollback_leases(state, &rollback_leases)?;
        return Err(
            rollback_error.unwrap_or_else(|| PREVIEW_AUTHORIZATION_CHANGED_ERROR.to_string())
        );
    }
    match retire_preview_leases_inner(state, &retired_leases) {
        Ok(()) => Ok(url),
        Err(PreviewRetirementError::AuthorizationUnavailable(error)) => {
            let _ = state.html_preview_server.stop_all_sites();
            Err(error)
        }
        #[cfg(test)]
        Err(PreviewRetirementError::Recoverable(error)) => {
            let mut rollback_leases = state
                .html_preview_server
                .remove_committed_generation(&_document, &_active_lease)
                .map_err(HtmlPreviewSitesRecoveryError::into_message)?;
            rollback_leases.extend(retired_leases);
            rollback_leases.insert(_active_lease);
            retire_preview_leases_inner(state, &rollback_leases)
                .map_err(|error| error.into_message())?;
            Err(error)
        }
    }
}

fn prepare_html_embed_with_scope_inner(
    state: &AppState,
    scope: AuthorizedPreviewScope,
    anchor: PathBuf,
    owner_window: &str,
) -> Result<MarkdownHtmlEmbedHandle, String> {
    let reserved_lease = scope.lease().clone();
    let key = HtmlEmbedSiteKey {
        anchor,
        document: scope.document().to_path_buf(),
    };
    #[cfg(test)]
    preview_commit_test_probe::run(state, &reserved_lease);
    let site_transaction: Result<HtmlEmbedPreviewCommit, HtmlPreviewSiteTransactionError> =
        (|| {
            if WorkspaceFileKind::classify(scope.document()) != Some(WorkspaceFileKind::Html) {
                return Err(HtmlPreviewSiteTransactionError::Operation(
                    "HTML preview requires an HTML file".into(),
                ));
            }
            let mut sites = state
                .html_preview_server
                .lock_sites()
                .map_err(HtmlPreviewSiteTransactionError::SitesRecovery)?;
            let owner_id = sites
                .allocate_embed_owner_id()
                .map_err(HtmlPreviewSiteTransactionError::Operation)?;
            let (url, active_lease, retired_leases) = if let Some(site) = sites.embeds.get_mut(&key)
            {
                if site.root.as_path() != scope.root() {
                    return Err(HtmlPreviewSiteTransactionError::Operation(
                        "HTML embed scope changed while the site was active".to_string(),
                    ));
                }
                site.owners.insert(owner_id, owner_window.to_string());
                (
                    site.url.clone(),
                    site.lease.clone(),
                    HashSet::from([reserved_lease.clone()]),
                )
            } else {
                if sites.len_all() >= MAX_PREVIEW_SITES {
                    return Err(HtmlPreviewSiteTransactionError::Operation(
                        "Too many active HTML preview sites".to_string(),
                    ));
                }
                let site = state
                    .html_preview_server
                    .start_disk_site(scope)
                    .map_err(HtmlPreviewSiteTransactionError::Operation)?;
                let url = site.url.clone();
                sites.embeds.insert(
                    key.clone(),
                    EmbeddedPreviewSite::new(site, owner_id, owner_window),
                );
                (url, reserved_lease.clone(), HashSet::new())
            };
            Ok(HtmlEmbedPreviewCommit {
                key,
                url,
                owner_id,
                active_lease,
                retired_leases,
            })
        })();
    let commit = match site_transaction {
        Ok(committed) => committed,
        Err(HtmlPreviewSiteTransactionError::Operation(error)) => {
            match retire_preview_lease_inner(state, &reserved_lease) {
                Ok(()) => return Err(error),
                Err(PreviewRetirementError::AuthorizationUnavailable(error)) => {
                    let _ = state.html_preview_server.stop_all_sites();
                    return Err(error);
                }
                #[cfg(test)]
                Err(PreviewRetirementError::Recoverable(error)) => return Err(error),
            }
        }
        Err(HtmlPreviewSiteTransactionError::SitesRecovery(recovery)) => {
            let (error, mut rollback_leases) = recovery.into_parts();
            rollback_leases.insert(reserved_lease.clone());
            match retire_preview_leases_inner(state, &rollback_leases) {
                Ok(()) => return Err(error),
                Err(PreviewRetirementError::AuthorizationUnavailable(error)) => {
                    let _ = state.html_preview_server.stop_all_sites();
                    return Err(error);
                }
                #[cfg(test)]
                Err(PreviewRetirementError::Recoverable(error)) => return Err(error),
            }
        }
    };
    let HtmlEmbedPreviewCommit {
        key: _key,
        url,
        owner_id: _owner_id,
        active_lease: _active_lease,
        retired_leases,
    } = commit;
    let lease_statuses =
        match preview_lease_support_statuses_inner(state, &[&reserved_lease, &_active_lease]) {
            Ok(statuses) => statuses,
            Err(error) => {
                let _ = state.html_preview_server.stop_all_sites();
                return Err(error);
            }
        };
    let reserved_lease_is_valid = lease_statuses[0];
    let active_lease_is_valid = lease_statuses[1];
    if !reserved_lease_is_valid || !active_lease_is_valid {
        let mut rollback_leases = retired_leases;
        rollback_leases.insert(reserved_lease);
        let rollback_error = match state.html_preview_server.rollback_committed_embed_owner(
            &_key,
            _owner_id,
            &_active_lease,
            !active_lease_is_valid,
        ) {
            Ok(removed_leases) => {
                rollback_leases.extend(removed_leases);
                None
            }
            Err(recovery) => {
                let (error, drained_leases) = recovery.into_parts();
                rollback_leases.extend(drained_leases);
                Some(error)
            }
        };
        retire_rollback_leases(state, &rollback_leases)?;
        return Err(
            rollback_error.unwrap_or_else(|| PREVIEW_AUTHORIZATION_CHANGED_ERROR.to_string())
        );
    }
    match retire_preview_leases_inner(state, &retired_leases) {
        Ok(()) => Ok(MarkdownHtmlEmbedHandle {
            url,
            owner_id: _owner_id,
        }),
        Err(PreviewRetirementError::AuthorizationUnavailable(error)) => {
            let _ = state.html_preview_server.stop_all_sites();
            Err(error)
        }
        #[cfg(test)]
        Err(PreviewRetirementError::Recoverable(error)) => {
            let mut rollback_leases = state
                .html_preview_server
                .rollback_committed_embed_owner(&_key, _owner_id, &_active_lease, false)
                .map_err(HtmlPreviewSitesRecoveryError::into_message)?;
            rollback_leases.extend(retired_leases);
            retire_preview_leases_inner(state, &rollback_leases)
                .map_err(|error| error.into_message())?;
            Err(error)
        }
    }
}

fn decode_embed_path(input: &str) -> Result<String, String> {
    let bytes = input.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err("Invalid percent-encoded HTML embed path".into());
            }
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3])
                .map_err(|_| "Invalid HTML embed path".to_string())?;
            decoded.push(
                u8::from_str_radix(hex, 16)
                    .map_err(|_| "Invalid percent-encoded HTML embed path".to_string())?,
            );
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).map_err(|_| "HTML embed path is not valid UTF-8".into())
}

fn relative_html_embed_path(html_src: &str) -> Result<PathBuf, String> {
    let source = html_src.trim();
    if source.is_empty() {
        return Err("HTML embed path is empty".into());
    }
    if source.contains(['?', '#']) {
        return Err("HTML embed paths cannot contain a query or fragment".into());
    }
    let decoded = decode_embed_path(source)?;
    if decoded.contains(['?', '#']) {
        return Err("HTML embed paths cannot contain a query or fragment".into());
    }
    let lower = decoded.to_ascii_lowercase();
    let has_scheme = lower.find(':').is_some_and(|colon| {
        colon > 0
            && lower[..colon].bytes().enumerate().all(|(index, byte)| {
                if index == 0 {
                    byte.is_ascii_alphabetic()
                } else {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-' | b'.')
                }
            })
    });
    if has_scheme || lower.starts_with("//") {
        return Err("Only relative local HTML embed paths are supported".into());
    }
    if decoded.contains('\\') {
        return Err("Backslashes are not allowed in HTML embed paths".into());
    }
    let path = PathBuf::from(&decoded);
    if path.is_absolute() || decoded.starts_with('/') || decoded.starts_with('~') {
        return Err("Absolute HTML embed paths are not allowed".into());
    }
    let encoded_source = source.to_ascii_lowercase();
    if encoded_source.contains("%2f") || encoded_source.contains("%5c") {
        return Err("Percent-encoded path separators are not allowed".into());
    }
    let has_encoded_parent = source.split('/').any(|segment| {
        segment != ".."
            && decode_embed_path(segment).is_ok_and(|decoded_segment| decoded_segment == "..")
    });
    if has_encoded_parent {
        return Err("Percent-encoded path traversal is not allowed".into());
    }
    if WorkspaceFileKind::classify(&path) != Some(WorkspaceFileKind::Html) {
        return Err("HTML embed requires an .html, .htm, or .xhtml file".into());
    }
    Ok(path)
}

#[cfg(test)]
pub(crate) fn acquire_markdown_html_embed_inner(
    state: &AppState,
    markdown_path: impl AsRef<Path>,
    html_src: &str,
    owner_window: &str,
) -> Result<MarkdownHtmlEmbedHandle, String> {
    acquire_markdown_html_embed_with_root_inner(state, markdown_path, html_src, owner_window, None)
}

fn acquire_markdown_html_embed_with_root_inner(
    state: &AppState,
    markdown_path: impl AsRef<Path>,
    html_src: &str,
    owner_window: &str,
    workspace_root: Option<&Path>,
) -> Result<MarkdownHtmlEmbedHandle, String> {
    let relative = relative_html_embed_path(html_src)?;
    let markdown = normalize_existing_path(markdown_path)
        .map_err(|_| "HTML embed requires an authorized Markdown file".to_string())?;
    if !markdown.is_file()
        || WorkspaceFileKind::classify(&markdown) != Some(WorkspaceFileKind::Markdown)
    {
        return Err("HTML embed requires an authorized Markdown file".into());
    }
    let markdown_parent = markdown
        .parent()
        .ok_or_else(|| "Markdown file has no parent directory".to_string())?;
    let target = normalize_existing_path(markdown_parent.join(relative))
        .map_err(|_| "HTML embed target is unavailable".to_string())?;
    if !target.is_file() {
        return Err("HTML embed target is not a file".into());
    }
    if workspace_root.is_none() && !path_is_under(&target, markdown_parent) {
        return Err("HTML embed target escaped the Markdown directory".into());
    }
    let scope =
        preview_scope_for_anchored_file_with_root_inner(state, &markdown, &target, workspace_root)?;
    prepare_html_embed_with_scope_inner(state, scope, markdown, owner_window)
}

#[cfg(test)]
pub(crate) fn prepare_markdown_html_embed_inner(
    state: &AppState,
    markdown_path: impl AsRef<Path>,
    html_src: &str,
) -> Result<String, String> {
    acquire_markdown_html_embed_inner(state, markdown_path, html_src, "test")
        .map(|handle| handle.url)
}

#[cfg(test)]
fn prepare_markdown_html_embed_in_workspace_inner(
    state: &AppState,
    markdown_path: impl AsRef<Path>,
    html_src: &str,
    workspace_root: impl AsRef<Path>,
) -> Result<String, String> {
    acquire_markdown_html_embed_with_root_inner(
        state,
        markdown_path,
        html_src,
        "test",
        Some(workspace_root.as_ref()),
    )
    .map(|handle| handle.url)
}

fn retire_released_embed_leases(
    state: &AppState,
    leases: &HashSet<PreviewLeaseId>,
) -> Result<(), String> {
    if leases.is_empty() {
        return Ok(());
    }
    match retire_preview_leases_inner(state, leases) {
        Ok(()) => Ok(()),
        Err(PreviewRetirementError::AuthorizationUnavailable(error)) => {
            let _ = state.html_preview_server.stop_all_sites();
            Err(error)
        }
        #[cfg(test)]
        Err(PreviewRetirementError::Recoverable(error)) => {
            retire_preview_leases_inner(state, leases)
                .map_err(PreviewRetirementError::into_message)?;
            Err(error)
        }
    }
}

pub(crate) fn release_markdown_html_embed_inner(
    state: &AppState,
    owner_id: u64,
    owner_window: &str,
) -> Result<(), String> {
    let retired_lease = {
        let mut sites = match state.html_preview_server.lock_sites() {
            Ok(sites) => sites,
            Err(recovery) => {
                let (error, drained_leases) = recovery.into_parts();
                retire_released_embed_leases(state, &drained_leases)?;
                return Err(error);
            }
        };
        let Some(key) = sites.embeds.iter().find_map(|(key, site)| {
            site.owners
                .get(&owner_id)
                .filter(|window| window.as_str() == owner_window)
                .map(|_| key.clone())
        }) else {
            return Ok(());
        };
        let should_remove = {
            let site = sites
                .embeds
                .get_mut(&key)
                .expect("owner lookup found an embedded preview site");
            site.owners.remove(&owner_id);
            site.owners.is_empty()
        };
        should_remove
            .then(|| sites.embeds.remove(&key).map(|site| site.lease.clone()))
            .flatten()
    };

    retire_released_embed_leases(state, &retired_lease.into_iter().collect())
}

pub(crate) fn release_markdown_html_embed_window_inner(
    state: &AppState,
    owner_window: &str,
) -> Result<(), String> {
    let retired_leases = {
        let mut sites = match state.html_preview_server.lock_sites() {
            Ok(sites) => sites,
            Err(recovery) => {
                let (error, drained_leases) = recovery.into_parts();
                retire_released_embed_leases(state, &drained_leases)?;
                return Err(error);
            }
        };
        for site in sites.embeds.values_mut() {
            site.owners.retain(|_, window| window != owner_window);
        }
        let empty_sites = sites
            .embeds
            .iter()
            .filter_map(|(key, site)| site.owners.is_empty().then_some(key.clone()))
            .collect::<Vec<_>>();
        empty_sites
            .into_iter()
            .filter_map(|key| sites.embeds.remove(&key).map(|site| site.lease.clone()))
            .collect::<HashSet<_>>()
    };

    retire_released_embed_leases(state, &retired_leases)
}

#[tauri::command]
pub(crate) fn prepare_html_preview(
    path: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    prepare_html_preview_inner(&state, path, &content)
}

#[tauri::command]
pub(crate) fn prepare_markdown_html_embed(
    markdown_path: String,
    html_src: String,
    workspace_root: Option<String>,
    webview_window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<MarkdownHtmlEmbedHandle, String> {
    acquire_markdown_html_embed_with_root_inner(
        &state,
        markdown_path,
        &html_src,
        webview_window.label(),
        workspace_root.as_deref().map(Path::new),
    )
}

#[tauri::command]
pub(crate) fn release_markdown_html_embed(
    owner_id: u64,
    webview_window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<(), String> {
    release_markdown_html_embed_inner(&state, owner_id, webview_window.label())
}

#[cfg(test)]
mod tests {
    use std::{
        collections::{HashMap, HashSet},
        fs,
        io::{Read, Write},
        net::TcpStream,
        sync::atomic::Ordering,
    };

    use tempfile::tempdir;

    use crate::{
        commands::{open_directory_inner, rename_workspace_entry_inner},
        models::{MutationKind, MutationOutcome},
        path_auth::{
            authorize_directory_root_inner, authorize_file_inner,
            ensure_authorized_existing_file_inner, ensure_authorized_write_file_inner,
            is_authorized_image_path, normalize_existing_path,
            relocate_authorized_path_prefix_inner, revoke_authorized_file_inner,
            revoke_authorized_path_prefix_inner,
        },
        state::AppState,
        workspace_file_kind::WorkspaceFileKind,
        workspace_index_commands::rebuild_workspace_index_inner,
    };

    use super::{
        acquire_markdown_html_embed_inner, prepare_html_preview_inner,
        prepare_markdown_html_embed_in_workspace_inner, prepare_markdown_html_embed_inner,
        release_markdown_html_embed_inner, release_markdown_html_embed_window_inner,
        MAX_PREVIEW_SITES,
    };

    fn http_request(url: &str, method: &str, headers: &[(&str, &str)]) -> Vec<u8> {
        let address_and_path = url.strip_prefix("http://").unwrap();
        let (address, path) = address_and_path.split_once('/').unwrap();
        http_request_with_host(address, path, method, address, headers)
    }

    fn http_request_with_host(
        address: &str,
        path: &str,
        method: &str,
        host: &str,
        headers: &[(&str, &str)],
    ) -> Vec<u8> {
        let mut stream = TcpStream::connect(address).unwrap();
        write!(
            stream,
            "{method} /{path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n"
        )
        .unwrap();
        for (name, value) in headers {
            write!(stream, "{name}: {value}\r\n").unwrap();
        }
        write!(stream, "\r\n").unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).unwrap();
        response
    }

    fn http_get(url: &str) -> String {
        String::from_utf8(http_request(url, "GET", &[])).unwrap()
    }

    fn response_body(response: &[u8]) -> &[u8] {
        let separator = response
            .windows(4)
            .position(|bytes| bytes == b"\r\n\r\n")
            .unwrap();
        &response[separator + 4..]
    }

    #[test]
    fn serves_live_html_and_relative_assets_over_loopback_http() {
        let dir = tempdir().unwrap();
        let site = dir.path().join("site");
        fs::create_dir(&site).unwrap();
        let html = site.join("index.html");
        fs::write(&html, "<h1>Saved</h1>").unwrap();
        fs::write(site.join("app.js"), "window.previewLoaded = true;").unwrap();
        let state = AppState::default();
        authorize_directory_root_inner(&state, dir.path().to_path_buf()).unwrap();

        let url = prepare_html_preview_inner(
            &state,
            &html,
            "<h1>Unsaved</h1><script src=\"app.js\"></script>",
        )
        .unwrap();

        assert!(url.starts_with("http://127.0.0.1:"));
        let html_response = http_get(&url);
        assert!(html_response.starts_with("HTTP/1.1 200"));
        assert!(html_response.contains("<h1>Unsaved</h1>"));
        assert!(!html_response
            .to_ascii_lowercase()
            .contains("access-control-allow-origin"));

        let asset_url = format!("{}/app.js", url.rsplit_once('/').unwrap().0);
        let asset_response = http_get(&asset_url);
        assert!(asset_response.starts_with("HTTP/1.1 200"));
        assert!(asset_response.contains("window.previewLoaded = true;"));

        let updated_url =
            prepare_html_preview_inner(&state, &html, "<h1>Updated again</h1>").unwrap();
        assert_eq!(updated_url, url);
        assert!(http_get(&updated_url).contains("<h1>Updated again</h1>"));
    }

    #[test]
    fn prepares_relative_html_embed_from_authorized_markdown() {
        let dir = tempdir().unwrap();
        let markdown = dir.path().join("notes.md");
        let embed_dir = dir.path().join("embed");
        fs::create_dir(&embed_dir).unwrap();
        fs::write(&markdown, "# Notes").unwrap();
        fs::write(
            embed_dir.join("index.html"),
            "<h1>Embedded</h1><script src=\"app.js\"></script>",
        )
        .unwrap();
        fs::write(embed_dir.join("app.js"), "window.embedded = true;").unwrap();
        let state = AppState::default();
        authorize_directory_root_inner(&state, dir.path().to_path_buf()).unwrap();

        let url = prepare_markdown_html_embed_inner(&state, &markdown, "embed/index.html")
            .expect("authorized relative HTML should be prepared");

        let response = http_get(&url);
        assert!(response.starts_with("HTTP/1.1 200"));
        assert!(response.contains("<h1>Embedded</h1>"));
        let asset_url = format!("{}/app.js", url.rsplit_once('/').unwrap().0);
        assert!(http_get(&asset_url).contains("window.embedded = true;"));
    }

    #[test]
    fn nested_markdown_embeds_parent_html_within_authorized_workspace() {
        let workspace = tempdir().unwrap();
        let notes = workspace.path().join("notes");
        let shared = workspace.path().join("shared");
        fs::create_dir(&notes).unwrap();
        fs::create_dir(&shared).unwrap();
        let markdown = notes.join("guide.md");
        fs::write(&markdown, "# Guide").unwrap();
        fs::write(
            shared.join("embed.html"),
            "<h1>Workspace embed</h1><script src=\"app.js\"></script>",
        )
        .unwrap();
        fs::write(shared.join("app.js"), "window.workspaceEmbed = true;").unwrap();
        fs::write(
            workspace.path().join("unrelated.js"),
            "window.unrelated = true;",
        )
        .unwrap();
        let state = AppState::default();
        authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();

        let url = prepare_markdown_html_embed_in_workspace_inner(
            &state,
            &markdown,
            "../shared/embed.html",
            workspace.path(),
        )
        .expect("a parent-relative embed inside the authorized workspace should be prepared");

        assert!(http_get(&url).contains("<h1>Workspace embed</h1>"));
        let asset_url = format!("{}/app.js", url.rsplit_once('/').unwrap().0);
        assert!(http_get(&asset_url).contains("window.workspaceEmbed = true;"));
        let authority = url
            .strip_prefix("http://")
            .unwrap()
            .split('/')
            .next()
            .unwrap();
        assert!(http_get(&format!("http://{authority}/unrelated.js")).starts_with("HTTP/1.1 404"));
    }

    #[test]
    fn parent_relative_html_embed_cannot_escape_authorized_workspace() {
        let container = tempdir().unwrap();
        let workspace = container.path().join("workspace");
        let notes = workspace.join("notes");
        fs::create_dir_all(&notes).unwrap();
        let markdown = notes.join("guide.md");
        fs::write(&markdown, "# Guide").unwrap();
        fs::write(container.path().join("outside.html"), "outside").unwrap();
        let state = AppState::default();
        authorize_directory_root_inner(&state, workspace.clone()).unwrap();

        let error = prepare_markdown_html_embed_in_workspace_inner(
            &state,
            &markdown,
            "../../outside.html",
            &workspace,
        )
        .expect_err("a parent-relative embed must remain inside its authorized workspace");

        assert!(error.contains("workspace"));
        assert!(state
            .file_authorization()
            .preview_lease_snapshot()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn standalone_preview_does_not_commit_a_lease_revoked_before_site_commit() {
        let workspace = tempdir().unwrap();
        let html = workspace.path().join("preview.html");
        fs::write(&html, "<h1>Saved</h1>").unwrap();
        let state = AppState::default();
        authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();
        let canonical_root = normalize_existing_path(workspace.path()).unwrap();

        super::preview_commit_test_probe::before_next_commit(move |state, _lease| {
            revoke_authorized_path_prefix_inner(state, &canonical_root).unwrap();
        });

        let error = prepare_html_preview_inner(&state, &html, "<h1>Draft</h1>")
            .expect_err("a revoked preview lease must not be committed");

        assert_eq!(
            error,
            "HTML preview authorization changed before the site was committed"
        );
        assert!(state
            .html_preview_server
            .site_documents()
            .unwrap()
            .is_empty());
        assert!(state
            .file_authorization()
            .preview_lease_snapshot()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn markdown_embed_does_not_commit_a_lease_revoked_before_site_commit() {
        let workspace = tempdir().unwrap();
        let markdown = workspace.path().join("notes.md");
        let html = workspace.path().join("embed.html");
        fs::write(&markdown, "<iframe src=\"embed.html\"></iframe>").unwrap();
        fs::write(&html, "<button>Click</button>").unwrap();
        let state = AppState::default();
        authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();
        let canonical_root = normalize_existing_path(workspace.path()).unwrap();

        super::preview_commit_test_probe::before_next_commit(move |state, _lease| {
            revoke_authorized_path_prefix_inner(state, &canonical_root).unwrap();
        });

        let error = acquire_markdown_html_embed_inner(&state, &markdown, "embed.html", "main")
            .expect_err("a revoked embed lease must not be committed");

        assert_eq!(
            error,
            "HTML preview authorization changed before the site was committed"
        );
        assert!(state
            .html_preview_server
            .site_lease_snapshot()
            .unwrap()
            .is_empty());
        assert!(state
            .file_authorization()
            .preview_lease_snapshot()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn reused_embed_removes_revoked_active_generation_before_returning_new_owner() {
        let workspace = tempdir().unwrap();
        let markdown = workspace.path().join("notes.md");
        let html = workspace.path().join("embed.html");
        fs::write(&markdown, "<iframe src=\"embed.html\"></iframe>").unwrap();
        fs::write(&html, "<button>Click</button>").unwrap();
        let state = AppState::default();
        authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();
        let first =
            acquire_markdown_html_embed_inner(&state, &markdown, "embed.html", "main").unwrap();
        let key = super::HtmlEmbedSiteKey {
            anchor: normalize_existing_path(&markdown).unwrap(),
            document: normalize_existing_path(&html).unwrap(),
        };
        let (active_lease, stop) = {
            let sites = state.html_preview_server.sites.lock().unwrap();
            let site = sites.embeds.get(&key).unwrap();
            (site.lease.clone(), site.stop.clone())
        };

        super::preview_commit_test_probe::before_next_commit(move |state, _reserved_lease| {
            crate::path_auth::retire_preview_lease_inner(state, &active_lease)
                .map_err(crate::path_auth::PreviewRetirementError::into_message)
                .unwrap();
        });

        let error = acquire_markdown_html_embed_inner(&state, &markdown, "embed.html", "main")
            .expect_err("a revoked active embed generation must not gain a new owner");

        assert_eq!(error, super::PREVIEW_AUTHORIZATION_CHANGED_ERROR);
        assert!(stop.load(Ordering::Acquire));
        assert!(state
            .html_preview_server
            .site_lease_snapshot()
            .unwrap()
            .is_empty());
        assert!(state
            .file_authorization()
            .preview_lease_snapshot()
            .unwrap()
            .is_empty());
        release_markdown_html_embed_inner(&state, first.owner_id, "main").unwrap();
    }

    #[test]
    fn reused_embed_rolls_back_only_new_owner_when_reserved_lease_was_revoked() {
        let workspace = tempdir().unwrap();
        let markdown = workspace.path().join("notes.md");
        let html = workspace.path().join("embed.html");
        fs::write(&markdown, "<iframe src=\"embed.html\"></iframe>").unwrap();
        fs::write(&html, "<button>Click</button>").unwrap();
        let state = AppState::default();
        authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();
        let first =
            acquire_markdown_html_embed_inner(&state, &markdown, "embed.html", "main").unwrap();
        let key = super::HtmlEmbedSiteKey {
            anchor: normalize_existing_path(&markdown).unwrap(),
            document: normalize_existing_path(&html).unwrap(),
        };
        let active_lease = state
            .html_preview_server
            .sites
            .lock()
            .unwrap()
            .embeds
            .get(&key)
            .unwrap()
            .lease
            .clone();

        super::preview_commit_test_probe::before_next_commit(|state, reserved_lease| {
            crate::path_auth::retire_preview_lease_inner(state, reserved_lease)
                .map_err(crate::path_auth::PreviewRetirementError::into_message)
                .unwrap();
        });

        let error = acquire_markdown_html_embed_inner(&state, &markdown, "embed.html", "main")
            .expect_err("a revoked reserved embed lease must roll back its owner");

        assert_eq!(error, super::PREVIEW_AUTHORIZATION_CHANGED_ERROR);
        {
            let sites = state.html_preview_server.sites.lock().unwrap();
            let retained = sites.embeds.get(&key).unwrap();
            assert_eq!(retained.lease, active_lease);
            assert_eq!(
                retained.owners,
                HashMap::from([(first.owner_id, "main".into())])
            );
        }
        assert_eq!(
            state.file_authorization().preview_lease_snapshot().unwrap(),
            HashSet::from([active_lease])
        );
        release_markdown_html_embed_inner(&state, first.owner_id, "main").unwrap();
    }

    #[test]
    fn markdown_embed_serves_only_files_under_the_markdown_parent() {
        let workspace = tempdir().unwrap();
        let notes = workspace.path().join("notes");
        fs::create_dir(&notes).unwrap();
        let markdown = notes.join("guide.md");
        let html = notes.join("embed.html");
        fs::write(&markdown, "# Guide").unwrap();
        fs::write(&html, "<script src=\"/shared.js\"></script>").unwrap();
        fs::write(notes.join("shared.js"), "window.shared = true;").unwrap();
        fs::write(workspace.path().join("secret.js"), "window.secret = true;").unwrap();
        let state = AppState::default();
        authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();

        let url = prepare_markdown_html_embed_inner(&state, &markdown, "embed.html").unwrap();
        let authority = url
            .strip_prefix("http://")
            .unwrap()
            .split('/')
            .next()
            .unwrap();

        assert!(http_get(&format!("http://{authority}/shared.js")).contains("window.shared"));
        assert!(http_get(&format!("http://{authority}/secret.js")).starts_with("HTTP/1.1 404"));
    }

    #[test]
    fn standalone_preview_and_markdown_embed_of_the_same_html_coexist() {
        let directory = tempdir().unwrap();
        let markdown = directory.path().join("notes.md");
        let html = directory.path().join("embed.html");
        fs::write(&markdown, "# Notes").unwrap();
        fs::write(&html, "<h1>Saved embed</h1>").unwrap();
        let state = AppState::default();
        authorize_directory_root_inner(&state, directory.path().to_path_buf()).unwrap();

        let standalone_url =
            prepare_html_preview_inner(&state, &html, "<h1>Unsaved draft</h1>").unwrap();
        let embed_url = prepare_markdown_html_embed_inner(&state, &markdown, "embed.html").unwrap();

        assert_ne!(standalone_url, embed_url);
        assert!(http_get(&standalone_url).contains("<h1>Unsaved draft</h1>"));
        assert!(http_get(&embed_url).contains("<h1>Saved embed</h1>"));
    }

    #[test]
    fn markdown_embed_reads_the_current_html_from_disk_for_each_request() {
        let directory = tempdir().unwrap();
        let markdown = directory.path().join("notes.md");
        let html = directory.path().join("embed.html");
        fs::write(&markdown, "# Notes").unwrap();
        fs::write(&html, "<h1>First version</h1>").unwrap();
        let state = AppState::default();
        authorize_directory_root_inner(&state, directory.path().to_path_buf()).unwrap();

        let url = prepare_markdown_html_embed_inner(&state, &markdown, "embed.html").unwrap();
        assert!(http_get(&url).contains("<h1>First version</h1>"));

        fs::write(&html, "<h1>Second version</h1>").unwrap();

        assert!(http_get(&url).contains("<h1>Second version</h1>"));
    }

    #[test]
    fn markdown_embed_site_lives_until_its_final_owner_releases_it() {
        let directory = tempdir().unwrap();
        let markdown = directory.path().join("notes.md");
        let html = directory.path().join("embed.html");
        fs::write(&markdown, "# Notes").unwrap();
        fs::write(&html, "<h1>Shared embed</h1>").unwrap();
        let state = AppState::default();
        authorize_directory_root_inner(&state, directory.path().to_path_buf()).unwrap();

        let first =
            acquire_markdown_html_embed_inner(&state, &markdown, "embed.html", "main").unwrap();
        let second =
            acquire_markdown_html_embed_inner(&state, &markdown, "embed.html", "main").unwrap();
        assert_eq!(first.url, second.url);
        assert_ne!(first.owner_id, second.owner_id);
        let stop = state
            .html_preview_server
            .embed_stop_flag_for_test(&markdown, &html)
            .unwrap();

        release_markdown_html_embed_inner(&state, first.owner_id, "main").unwrap();

        assert!(!stop.load(std::sync::atomic::Ordering::Acquire));
        assert!(http_get(&second.url).contains("<h1>Shared embed</h1>"));
        assert_eq!(
            state
                .file_authorization()
                .preview_lease_snapshot()
                .unwrap()
                .len(),
            1
        );

        release_markdown_html_embed_inner(&state, second.owner_id, "main").unwrap();

        assert!(stop.load(std::sync::atomic::Ordering::Acquire));
        assert!(state
            .file_authorization()
            .preview_lease_snapshot()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn mismatched_window_cannot_release_an_embed_owner() {
        let directory = tempdir().unwrap();
        let markdown = directory.path().join("notes.md");
        let html = directory.path().join("embed.html");
        fs::write(&markdown, "# Notes").unwrap();
        fs::write(&html, "<h1>Shared embed</h1>").unwrap();
        let state = AppState::default();
        authorize_directory_root_inner(&state, directory.path().to_path_buf()).unwrap();
        let handle =
            acquire_markdown_html_embed_inner(&state, &markdown, "embed.html", "main").unwrap();
        let key = super::HtmlEmbedSiteKey {
            anchor: normalize_existing_path(&markdown).unwrap(),
            document: normalize_existing_path(&html).unwrap(),
        };
        let (lease, stop) = {
            let sites = state.html_preview_server.sites.lock().unwrap();
            let site = sites.embeds.get(&key).unwrap();
            (site.lease.clone(), site.stop.clone())
        };

        assert!(
            release_markdown_html_embed_inner(&state, handle.owner_id, "guessed-window",).is_ok()
        );

        {
            let sites = state.html_preview_server.sites.lock().unwrap();
            let site = sites.embeds.get(&key).unwrap();
            assert_eq!(site.lease, lease);
            assert_eq!(
                site.owners,
                HashMap::from([(handle.owner_id, "main".into())])
            );
        }
        assert!(!stop.load(Ordering::Acquire));
        assert_eq!(
            state.file_authorization().preview_lease_snapshot().unwrap(),
            HashSet::from([lease])
        );

        release_markdown_html_embed_inner(&state, handle.owner_id, "main").unwrap();
    }

    #[test]
    fn window_cleanup_removes_only_that_windows_owners_until_the_final_window_closes() {
        let directory = tempdir().unwrap();
        let markdown = directory.path().join("notes.md");
        let html = directory.path().join("embed.html");
        fs::write(&markdown, "# Notes").unwrap();
        fs::write(&html, "<h1>Shared embed</h1>").unwrap();
        let state = AppState::default();
        authorize_directory_root_inner(&state, directory.path().to_path_buf()).unwrap();
        let main_first =
            acquire_markdown_html_embed_inner(&state, &markdown, "embed.html", "main").unwrap();
        let main_second =
            acquire_markdown_html_embed_inner(&state, &markdown, "embed.html", "main").unwrap();
        let popout =
            acquire_markdown_html_embed_inner(&state, &markdown, "embed.html", "popout").unwrap();
        let key = super::HtmlEmbedSiteKey {
            anchor: normalize_existing_path(&markdown).unwrap(),
            document: normalize_existing_path(&html).unwrap(),
        };
        let (lease, stop) = {
            let sites = state.html_preview_server.sites.lock().unwrap();
            let site = sites.embeds.get(&key).unwrap();
            (site.lease.clone(), site.stop.clone())
        };

        release_markdown_html_embed_window_inner(&state, "main").unwrap();

        {
            let sites = state.html_preview_server.sites.lock().unwrap();
            let site = sites.embeds.get(&key).unwrap();
            assert_eq!(site.lease, lease);
            assert_eq!(
                site.owners,
                HashMap::from([(popout.owner_id, "popout".into())])
            );
            assert!(!site.owners.contains_key(&main_first.owner_id));
            assert!(!site.owners.contains_key(&main_second.owner_id));
        }
        assert!(!stop.load(Ordering::Acquire));
        assert_eq!(
            state.file_authorization().preview_lease_snapshot().unwrap(),
            HashSet::from([lease])
        );

        release_markdown_html_embed_window_inner(&state, "popout").unwrap();

        assert!(stop.load(Ordering::Acquire));
        assert!(state
            .html_preview_server
            .sites
            .lock()
            .unwrap()
            .embeds
            .is_empty());
        assert!(state
            .file_authorization()
            .preview_lease_snapshot()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn poisoned_site_map_window_cleanup_stops_drained_sites_and_retires_their_leases() {
        let directory = tempdir().unwrap();
        let markdown = directory.path().join("notes.md");
        let html = directory.path().join("embed.html");
        fs::write(&markdown, "# Notes").unwrap();
        fs::write(&html, "<h1>Shared embed</h1>").unwrap();
        let state = AppState::default();
        authorize_directory_root_inner(&state, directory.path().to_path_buf()).unwrap();
        acquire_markdown_html_embed_inner(&state, &markdown, "embed.html", "main").unwrap();
        let stop = state
            .html_preview_server
            .embed_stop_flag_for_test(&markdown, &html)
            .unwrap();

        let poison = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _sites = state.html_preview_server.sites.lock().unwrap();
            panic!("injected HTML site map poison before window cleanup");
        }));
        assert!(poison.is_err());
        assert!(state.html_preview_server.sites.is_poisoned());

        let _cleanup_result = release_markdown_html_embed_window_inner(&state, "main");

        assert!(!state.html_preview_server.sites.is_poisoned());
        assert!(state
            .html_preview_server
            .sites
            .lock()
            .unwrap()
            .embeds
            .is_empty());
        assert!(stop.load(Ordering::Acquire));
        assert!(state
            .file_authorization()
            .preview_lease_snapshot()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn renaming_the_markdown_anchor_stops_its_active_embed_site() {
        let directory = tempdir().unwrap();
        let markdown = directory.path().join("notes.md");
        let renamed_markdown = directory.path().join("renamed.md");
        let html = directory.path().join("embed.html");
        fs::write(&markdown, "# Notes").unwrap();
        fs::write(&html, "<h1>Embed</h1>").unwrap();
        let canonical_markdown = normalize_existing_path(&markdown).unwrap();
        let state = AppState::default();
        authorize_directory_root_inner(&state, directory.path().to_path_buf()).unwrap();
        let handle =
            acquire_markdown_html_embed_inner(&state, &markdown, "embed.html", "main").unwrap();
        let stop = state
            .html_preview_server
            .embed_stop_flag_for_test(&markdown, &html)
            .unwrap();

        fs::rename(&markdown, &renamed_markdown).unwrap();
        let canonical_renamed_markdown = normalize_existing_path(&renamed_markdown).unwrap();
        relocate_authorized_path_prefix_inner(
            &state,
            &canonical_markdown,
            &canonical_renamed_markdown,
        )
        .unwrap();

        assert!(stop.load(std::sync::atomic::Ordering::Acquire));
        assert!(state
            .file_authorization()
            .preview_lease_snapshot()
            .unwrap()
            .is_empty());
        release_markdown_html_embed_inner(&state, handle.owner_id, "main").unwrap();
    }

    #[test]
    fn two_markdown_anchors_have_independent_embed_lifetimes() {
        let directory = tempdir().unwrap();
        let first_markdown = directory.path().join("first.md");
        let renamed_first_markdown = directory.path().join("renamed-first.md");
        let second_markdown = directory.path().join("second.md");
        let html = directory.path().join("embed.html");
        fs::write(&first_markdown, "# First").unwrap();
        fs::write(&second_markdown, "# Second").unwrap();
        fs::write(&html, "<h1>Shared embed</h1>").unwrap();
        let canonical_first_markdown = normalize_existing_path(&first_markdown).unwrap();
        let state = AppState::default();
        authorize_directory_root_inner(&state, directory.path().to_path_buf()).unwrap();
        let first =
            acquire_markdown_html_embed_inner(&state, &first_markdown, "embed.html", "main")
                .unwrap();
        let second =
            acquire_markdown_html_embed_inner(&state, &second_markdown, "embed.html", "main")
                .unwrap();
        assert_ne!(first.url, second.url);
        let first_stop = state
            .html_preview_server
            .embed_stop_flag_for_test(&first_markdown, &html)
            .unwrap();
        let second_stop = state
            .html_preview_server
            .embed_stop_flag_for_test(&second_markdown, &html)
            .unwrap();

        fs::rename(&first_markdown, &renamed_first_markdown).unwrap();
        let canonical_renamed = normalize_existing_path(&renamed_first_markdown).unwrap();
        relocate_authorized_path_prefix_inner(
            &state,
            &canonical_first_markdown,
            &canonical_renamed,
        )
        .unwrap();

        assert!(first_stop.load(std::sync::atomic::Ordering::Acquire));
        assert!(!second_stop.load(std::sync::atomic::Ordering::Acquire));
        assert!(http_get(&second.url).contains("<h1>Shared embed</h1>"));
        assert_eq!(
            state
                .file_authorization()
                .preview_lease_snapshot()
                .unwrap()
                .len(),
            1
        );
        release_markdown_html_embed_inner(&state, second.owner_id, "main").unwrap();
    }

    #[test]
    fn rejects_unsafe_markdown_html_embed_sources_before_allocating_a_lease() {
        let dir = tempdir().unwrap();
        let markdown = dir.path().join("notes.md");
        fs::write(&markdown, "# Notes").unwrap();
        let state = AppState::default();
        authorize_directory_root_inner(&state, dir.path().to_path_buf()).unwrap();

        for source in [
            "",
            "https://example.com/embed.html",
            "//example.com/embed.html",
            "/tmp/embed.html",
            "C:\\embed.html",
            "../embed.html",
            "%2e%2e/embed.html",
            "embed%2findex.html",
            "embed\\index.html",
            "embed.txt",
            "embed.html?mode=preview",
            "embed.html#section",
        ] {
            assert!(
                prepare_markdown_html_embed_inner(&state, &markdown, source).is_err(),
                "unsafe source was accepted: {source}"
            );
            assert!(state
                .file_authorization()
                .preview_lease_snapshot()
                .unwrap()
                .is_empty());
        }
    }

    #[test]
    fn rejects_missing_unauthorized_and_symlink_escape_html_embeds() {
        let dir = tempdir().unwrap();
        let markdown = dir.path().join("notes.md");
        let existing = dir.path().join("existing.html");
        fs::write(&markdown, "# Notes").unwrap();
        fs::write(&existing, "existing").unwrap();

        let unauthorized_state = AppState::default();
        assert!(
            prepare_markdown_html_embed_inner(&unauthorized_state, &markdown, "existing.html")
                .is_err()
        );

        let state = AppState::default();
        authorize_directory_root_inner(&state, dir.path().to_path_buf()).unwrap();
        assert!(prepare_markdown_html_embed_inner(&state, &markdown, "missing.html").is_err());

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;

            let outside = tempdir().unwrap();
            let target = outside.path().join("outside.html");
            fs::write(&target, "outside").unwrap();
            symlink(&target, dir.path().join("linked.html")).unwrap();
            let error =
                prepare_markdown_html_embed_inner(&state, &markdown, "linked.html").unwrap_err();
            assert!(error.contains("escaped the Markdown directory"));
        }

        assert!(state
            .file_authorization()
            .preview_lease_snapshot()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn serves_non_utf8_html_bytes_without_a_prepare_time_decode() {
        let dir = tempdir().unwrap();
        let markdown = dir.path().join("notes.md");
        let html = dir.path().join("invalid.html");
        fs::write(&markdown, "# Notes").unwrap();
        fs::write(&html, [0xff, 0xfe]).unwrap();
        let state = AppState::default();
        authorize_directory_root_inner(&state, dir.path().to_path_buf()).unwrap();

        let handle =
            acquire_markdown_html_embed_inner(&state, &markdown, "invalid.html", "main").unwrap();
        let response = http_request(&handle.url, "GET", &[]);

        assert_eq!(response_body(&response), [0xff, 0xfe]);
        release_markdown_html_embed_inner(&state, handle.owner_id, "main").unwrap();
        assert!(state
            .file_authorization()
            .preview_lease_snapshot()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn standalone_markdown_can_embed_a_sibling_without_html_write_authority() {
        let dir = tempdir().unwrap();
        let markdown = dir.path().join("notes.md");
        let html = dir.path().join("embed.html");
        fs::write(&markdown, "# Notes").unwrap();
        fs::write(&html, "<h1>Embed</h1>").unwrap();
        let state = AppState::default();
        authorize_file_inner(&state, markdown.clone()).unwrap();

        let url = prepare_markdown_html_embed_inner(&state, &markdown, "embed.html").unwrap();

        assert!(http_get(&url).contains("<h1>Embed</h1>"));
        assert!(ensure_authorized_write_file_inner(&state, &html).is_err());
    }

    #[test]
    fn isolates_preview_documents_on_separate_origins() {
        let dir = tempdir().unwrap();
        let first = dir.path().join("first.html");
        let second = dir.path().join("second.html");
        fs::write(&first, "first").unwrap();
        fs::write(&second, "second").unwrap();
        let state = AppState::default();
        authorize_directory_root_inner(&state, dir.path().to_path_buf()).unwrap();

        let first_url = prepare_html_preview_inner(&state, &first, "first").unwrap();
        let second_url = prepare_html_preview_inner(&state, &second, "second").unwrap();
        let first_origin = first_url.rsplit_once('/').unwrap().0;
        let second_origin = second_url.rsplit_once('/').unwrap().0;

        assert_ne!(first_origin, second_origin);
    }

    #[test]
    fn gives_workspace_pages_normal_root_relative_url_semantics() {
        let dir = tempdir().unwrap();
        let site = dir.path().join("site");
        fs::create_dir(&site).unwrap();
        let html = site.join("index.html");
        fs::write(&html, "<script src=\"/root.js\"></script>").unwrap();
        fs::write(dir.path().join("root.js"), "window.fromRoot = true;").unwrap();
        let state = AppState::default();
        authorize_directory_root_inner(&state, dir.path().to_path_buf()).unwrap();

        let url = prepare_html_preview_inner(&state, &html, "<script src=\"/root.js\"></script>")
            .unwrap();
        let address = url
            .strip_prefix("http://")
            .unwrap()
            .split('/')
            .next()
            .unwrap();

        let response = http_get(&format!("http://{address}/root.js"));
        assert!(response.starts_with("HTTP/1.1 200"));
        assert!(response.contains("window.fromRoot = true;"));
    }

    #[test]
    fn preview_scope_uses_the_most_specific_authorized_root() {
        let workspace = tempdir().unwrap();
        let site = workspace.path().join("site");
        fs::create_dir(&site).unwrap();
        let html = site.join("index.html");
        fs::write(&html, "<script src=\"app.js\"></script>").unwrap();
        fs::write(site.join("app.js"), "window.fromSite = true;").unwrap();
        fs::write(workspace.path().join("root.js"), "window.fromRoot = true;").unwrap();
        let state = AppState::default();
        authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();
        authorize_file_inner(&state, html.clone()).unwrap();

        let url =
            prepare_html_preview_inner(&state, &html, "<script src=\"app.js\"></script>").unwrap();
        let address = url
            .strip_prefix("http://")
            .unwrap()
            .split('/')
            .next()
            .unwrap();

        assert!(!url.contains("/site/"));
        assert!(http_get(&format!("http://{address}/app.js")).starts_with("HTTP/1.1 200"));
        assert!(http_get(&format!("http://{address}/root.js")).starts_with("HTTP/1.1 404"));
    }

    #[test]
    fn reprepare_applies_changed_authorized_scope_root() {
        let workspace = tempdir().unwrap();
        let site = workspace.path().join("site");
        fs::create_dir(&site).unwrap();
        let html = site.join("index.html");
        fs::write(&html, "<script src=\"/scope.js\"></script>").unwrap();
        fs::write(
            workspace.path().join("scope.js"),
            "window.previewScope = 'wide';",
        )
        .unwrap();
        fs::write(site.join("scope.js"), "window.previewScope = 'narrow';").unwrap();
        let canonical_document = normalize_existing_path(&html).unwrap();
        let state = AppState::default();
        authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();

        let wide_url =
            prepare_html_preview_inner(&state, &html, "<script src=\"/scope.js\"></script>")
                .unwrap();
        let wide_address = wide_url
            .strip_prefix("http://")
            .unwrap()
            .split('/')
            .next()
            .unwrap();
        let wide_asset_url = format!("http://{wide_address}/scope.js");
        assert!(http_get(&wide_asset_url).contains("previewScope = 'wide'"));
        let old_worker_stop = state
            .html_preview_server
            .sites
            .lock()
            .unwrap()
            .get(&canonical_document)
            .unwrap()
            .stop
            .clone();

        authorize_file_inner(&state, html.clone()).unwrap();
        let (narrow_url, reprepare_events) = crate::path_auth::lock_order_test_probe::trace(|| {
            prepare_html_preview_inner(&state, &html, "<script src=\"/scope.js\"></script>")
        });
        let narrow_url = narrow_url.unwrap();

        assert_ne!(
            narrow_url, wide_url,
            "changed authorized root reused the old preview worker"
        );
        let narrow_address = narrow_url
            .strip_prefix("http://")
            .unwrap()
            .split('/')
            .next()
            .unwrap();
        let narrow_asset_url = format!("http://{narrow_address}/scope.js");
        assert!(http_get(&narrow_asset_url).contains("previewScope = 'narrow'"));
        assert!(old_worker_stop.load(std::sync::atomic::Ordering::Acquire));
        assert_eq!(
            reprepare_events,
            [
                crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationAcquired,
                crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationReleased,
                crate::path_auth::lock_order_test_probe::LockEvent::HtmlSitesAcquired,
                crate::path_auth::lock_order_test_probe::LockEvent::HtmlSitesReleased,
                crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationAcquired,
                crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationReleased,
                crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationAcquired,
                crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationReleased,
            ]
        );
    }

    #[test]
    fn failed_site_commit_rolls_back_only_new_preview_lease() {
        let workspace = tempdir().unwrap();
        let site = workspace.path().join("site");
        fs::create_dir(&site).unwrap();
        let html = site.join("index.html");
        fs::write(&html, "saved").unwrap();
        fs::write(
            workspace.path().join("scope.js"),
            "window.previewScope = 'wide';",
        )
        .unwrap();
        fs::write(site.join("scope.js"), "window.previewScope = 'narrow';").unwrap();
        let canonical_document = normalize_existing_path(&html).unwrap();
        let canonical_wide_root = normalize_existing_path(workspace.path()).unwrap();
        let state = AppState::default();
        authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();

        let old_content = "<h1>old preview</h1><script src=\"/scope.js\"></script>";
        let old_url = prepare_html_preview_inner(&state, &html, old_content).unwrap();
        let old_address = old_url
            .strip_prefix("http://")
            .unwrap()
            .split('/')
            .next()
            .unwrap();
        let old_asset_url = format!("http://{old_address}/scope.js");
        let (old_lease, old_stop, old_server, old_content_state) = {
            let sites = state.html_preview_server.sites.lock().unwrap();
            let old_site = sites.get(&canonical_document).unwrap();
            (
                old_site.lease.clone(),
                old_site.stop.clone(),
                old_site.server.clone(),
                old_site.content.clone(),
            )
        };

        authorize_file_inner(&state, html.clone()).unwrap();
        let leases_before = state.file_authorization().preview_lease_snapshot().unwrap();
        let sites_before = state.html_preview_server.site_documents().unwrap();
        assert_eq!(leases_before, HashSet::from([old_lease.clone()]));
        state
            .html_preview_server
            .fail_next_site_start("injected replacement start failure")
            .unwrap();

        let (result, events) = crate::path_auth::lock_order_test_probe::trace(|| {
            prepare_html_preview_inner(&state, &html, "<h1>replacement preview</h1>")
        });
        let error = result.expect_err("injected replacement start must fail");
        assert_eq!(error, "injected replacement start failure");
        let leases_after = state.file_authorization().preview_lease_snapshot().unwrap();

        assert_eq!(
            leases_after, leases_before,
            "failed site commit leaked the newly reserved preview generation"
        );
        assert_eq!(
            state.html_preview_server.site_documents().unwrap(),
            sites_before,
            "failed replacement changed the preview site map"
        );
        {
            let sites = state.html_preview_server.sites.lock().unwrap();
            let retained = sites.get(&canonical_document).unwrap();
            assert_eq!(retained.url, old_url);
            assert_eq!(retained.root, canonical_wide_root);
            assert_eq!(retained.lease, old_lease);
            assert!(std::sync::Arc::ptr_eq(&retained.stop, &old_stop));
            assert!(std::sync::Arc::ptr_eq(&retained.server, &old_server));
            assert!(retained.content.shares_state_with(&old_content_state));
        }
        assert!(!old_stop.load(std::sync::atomic::Ordering::Acquire));
        assert!(http_get(&old_url).contains("<h1>old preview</h1>"));
        assert!(http_get(&old_asset_url).contains("previewScope = 'wide'"));
        assert_eq!(
            events,
            [
                crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationAcquired,
                crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationReleased,
                crate::path_auth::lock_order_test_probe::LockEvent::HtmlSitesAcquired,
                crate::path_auth::lock_order_test_probe::LockEvent::HtmlSitesReleased,
                crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationAcquired,
                crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationReleased,
            ]
        );
    }

    #[test]
    fn authorization_unavailable_during_failed_commit_rollback_stops_all_preview_sites() {
        let workspace = tempdir().unwrap();
        let target_root = workspace.path().join("target");
        fs::create_dir(&target_root).unwrap();
        let target = target_root.join("index.html");
        let unrelated = workspace.path().join("unrelated.html");
        fs::write(&target, "saved target").unwrap();
        fs::write(&unrelated, "saved unrelated").unwrap();
        let canonical_target = normalize_existing_path(&target).unwrap();
        let canonical_unrelated = normalize_existing_path(&unrelated).unwrap();
        let state = AppState::default();
        authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();

        let target_url = prepare_html_preview_inner(&state, &target, "live target").unwrap();
        let unrelated_url =
            prepare_html_preview_inner(&state, &unrelated, "live unrelated").unwrap();
        assert!(http_get(&target_url).contains("live target"));
        assert!(http_get(&unrelated_url).contains("live unrelated"));
        let (target_stop, unrelated_stop) = {
            let sites = state.html_preview_server.sites.lock().unwrap();
            (
                sites.get(&canonical_target).unwrap().stop.clone(),
                sites.get(&canonical_unrelated).unwrap().stop.clone(),
            )
        };

        authorize_file_inner(&state, target.clone()).unwrap();
        state
            .html_preview_server
            .fail_next_site_start("injected replacement start failure")
            .unwrap();
        state
            .file_authorization()
            .fail_next_preview_retirement_as_unavailable(
                "injected authorization unavailable during failed-commit rollback",
            )
            .unwrap();

        let (result, events) = crate::path_auth::lock_order_test_probe::trace(|| {
            prepare_html_preview_inner(&state, &target, "uncommitted replacement")
        });
        let error = result.expect_err("authorization-unavailable rollback must not return a URL");
        assert_eq!(
            error,
            "injected authorization unavailable during failed-commit rollback"
        );
        let documents_after = state.html_preview_server.site_documents().unwrap();

        assert!(
            documents_after.is_empty(),
            "authorization-unavailable rollback preserved unverified preview sites: {documents_after:?}"
        );
        assert!(target_stop.load(std::sync::atomic::Ordering::Acquire));
        assert!(unrelated_stop.load(std::sync::atomic::Ordering::Acquire));
        assert_eq!(
            events,
            [
                crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationAcquired,
                crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationReleased,
                crate::path_auth::lock_order_test_probe::LockEvent::HtmlSitesAcquired,
                crate::path_auth::lock_order_test_probe::LockEvent::HtmlSitesReleased,
                crate::path_auth::lock_order_test_probe::LockEvent::HtmlSitesAcquired,
                crate::path_auth::lock_order_test_probe::LockEvent::HtmlSitesReleased,
            ]
        );
    }

    #[test]
    fn capacity_rejection_preserves_every_active_preview_site() {
        let workspace = tempdir().unwrap();
        let documents = (0..=MAX_PREVIEW_SITES)
            .map(|index| {
                let document = workspace.path().join(format!("site-{index}.html"));
                fs::write(&document, format!("saved site {index}")).unwrap();
                document
            })
            .collect::<Vec<_>>();
        let state = AppState::default();
        authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();

        let active_urls = documents
            .iter()
            .take(MAX_PREVIEW_SITES)
            .enumerate()
            .map(|(index, document)| {
                prepare_html_preview_inner(&state, document, &format!("live site {index}")).unwrap()
            })
            .collect::<Vec<_>>();

        let authorization_before = state.file_authorization().preview_lease_snapshot().unwrap();
        let sites_before = state.html_preview_server.site_lease_snapshot().unwrap();
        assert_eq!(authorization_before, sites_before);
        assert_eq!(sites_before.len(), MAX_PREVIEW_SITES);
        let worker_stops_before = {
            let sites = state.html_preview_server.sites.lock().unwrap();
            sites
                .values()
                .map(|site| (site.lease.clone(), site.stop.clone()))
                .collect::<Vec<_>>()
        };

        let new_document = normalize_existing_path(&documents[MAX_PREVIEW_SITES]).unwrap();
        let (result, events) = crate::path_auth::lock_order_test_probe::trace(|| {
            prepare_html_preview_inner(
                &state,
                &new_document,
                &format!("live site {MAX_PREVIEW_SITES}"),
            )
        });
        let error = result.expect_err("capacity must reject a new preview site");
        let sites_after = state.html_preview_server.site_lease_snapshot().unwrap();
        let authorization_after = state.file_authorization().preview_lease_snapshot().unwrap();

        assert!(error.contains("Too many active HTML preview sites"));
        assert_eq!(sites_after, sites_before);
        assert_eq!(authorization_after, authorization_before);
        assert!(!state
            .html_preview_server
            .site_documents()
            .unwrap()
            .contains(&new_document));
        assert!(worker_stops_before
            .iter()
            .all(|(_, stop)| !stop.load(std::sync::atomic::Ordering::Acquire)));
        for (index, url) in active_urls.iter().enumerate() {
            assert!(http_get(url).contains(&format!("live site {index}")));
        }
        assert_eq!(
            events,
            [
                crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationAcquired,
                crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationReleased,
                crate::path_auth::lock_order_test_probe::LockEvent::HtmlSitesAcquired,
                crate::path_auth::lock_order_test_probe::LockEvent::HtmlSitesReleased,
                crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationAcquired,
                crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationReleased,
            ]
        );
    }

    #[test]
    fn post_commit_retirement_failure_removes_committed_generation_and_preserves_unrelated_site() {
        let workspace = tempdir().unwrap();
        let target = workspace.path().join("target.html");
        let unrelated = workspace.path().join("unrelated.html");
        fs::write(&target, "saved target").unwrap();
        fs::write(&unrelated, "saved unrelated").unwrap();
        let canonical_target = normalize_existing_path(&target).unwrap();
        let canonical_unrelated = normalize_existing_path(&unrelated).unwrap();
        let state = AppState::default();
        authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();

        let target_url = prepare_html_preview_inner(&state, &target, "old target content").unwrap();
        let unrelated_url =
            prepare_html_preview_inner(&state, &unrelated, "stable unrelated content").unwrap();
        let (
            old_target_lease,
            target_stop,
            unrelated_lease,
            unrelated_stop,
            unrelated_server,
            unrelated_content,
        ) = {
            let sites = state.html_preview_server.sites.lock().unwrap();
            let target_site = sites.get(&canonical_target).unwrap();
            let unrelated_site = sites.get(&canonical_unrelated).unwrap();
            (
                target_site.lease.clone(),
                target_site.stop.clone(),
                unrelated_site.lease.clone(),
                unrelated_site.stop.clone(),
                unrelated_site.server.clone(),
                unrelated_site.content.clone(),
            )
        };
        let leases_before = state.file_authorization().preview_lease_snapshot().unwrap();
        assert_eq!(
            leases_before,
            HashSet::from([old_target_lease.clone(), unrelated_lease.clone()])
        );
        assert_eq!(
            state.html_preview_server.site_lease_snapshot().unwrap(),
            leases_before
        );
        state
            .file_authorization()
            .fail_next_preview_retirement("injected post-commit retirement failure")
            .unwrap();

        let (result, events) = crate::path_auth::lock_order_test_probe::trace(|| {
            prepare_html_preview_inner(&state, &target, "new committed target content")
        });
        let error = result.expect_err("injected post-commit retirement must fail");
        assert_eq!(error, "injected post-commit retirement failure");
        let documents_after = state.html_preview_server.site_documents().unwrap();
        let target_remained = documents_after.contains(&canonical_target);
        let serves_new_content =
            target_remained && http_get(&target_url).contains("new committed target content");

        assert!(
            !target_remained,
            "post-commit cleanup failure left the committed target live; serves_new_content={serves_new_content}"
        );
        assert!(target_stop.load(std::sync::atomic::Ordering::Acquire));
        assert_eq!(
            documents_after,
            HashSet::from([canonical_unrelated.clone()])
        );
        {
            let sites = state.html_preview_server.sites.lock().unwrap();
            let retained = sites.get(&canonical_unrelated).unwrap();
            assert_eq!(retained.url, unrelated_url);
            assert_eq!(retained.lease, unrelated_lease);
            assert!(std::sync::Arc::ptr_eq(&retained.stop, &unrelated_stop));
            assert!(std::sync::Arc::ptr_eq(&retained.server, &unrelated_server));
            assert!(retained.content.shares_state_with(&unrelated_content));
        }
        assert!(!unrelated_stop.load(std::sync::atomic::Ordering::Acquire));
        assert!(http_get(&unrelated_url).contains("stable unrelated content"));
        let expected_leases = HashSet::from([unrelated_lease]);
        assert_eq!(
            state.html_preview_server.site_lease_snapshot().unwrap(),
            expected_leases
        );
        assert_eq!(
            state.file_authorization().preview_lease_snapshot().unwrap(),
            expected_leases
        );
        assert_eq!(
            events,
            [
                crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationAcquired,
                crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationReleased,
                crate::path_auth::lock_order_test_probe::LockEvent::HtmlSitesAcquired,
                crate::path_auth::lock_order_test_probe::LockEvent::HtmlSitesReleased,
                crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationAcquired,
                crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationReleased,
                crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationAcquired,
                crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationReleased,
                crate::path_auth::lock_order_test_probe::LockEvent::HtmlSitesAcquired,
                crate::path_auth::lock_order_test_probe::LockEvent::HtmlSitesReleased,
                crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationAcquired,
                crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationReleased,
            ]
        );
    }

    #[test]
    fn authorization_unavailable_during_cleanup_stops_all_preview_sites() {
        let workspace = tempdir().unwrap();
        let target = workspace.path().join("target.html");
        let unrelated = workspace.path().join("unrelated.html");
        fs::write(&target, "saved target").unwrap();
        fs::write(&unrelated, "saved unrelated").unwrap();
        let state = AppState::default();
        authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();

        prepare_html_preview_inner(&state, &target, "old target content").unwrap();
        prepare_html_preview_inner(&state, &unrelated, "unrelated content").unwrap();
        let (target_stop, unrelated_stop) = {
            let sites = state.html_preview_server.sites.lock().unwrap();
            (
                sites
                    .get(&normalize_existing_path(&target).unwrap())
                    .unwrap()
                    .stop
                    .clone(),
                sites
                    .get(&normalize_existing_path(&unrelated).unwrap())
                    .unwrap()
                    .stop
                    .clone(),
            )
        };
        state
            .file_authorization()
            .fail_next_preview_retirement_as_unavailable(
                "injected authorization unavailable during preview cleanup",
            )
            .unwrap();

        let (result, events) = crate::path_auth::lock_order_test_probe::trace(|| {
            prepare_html_preview_inner(&state, &target, "new committed target content")
        });
        let error = result.expect_err("authorization-unavailable cleanup must not return a URL");
        assert_eq!(
            error,
            "injected authorization unavailable during preview cleanup"
        );
        let documents_after = state.html_preview_server.site_documents().unwrap();

        assert!(
            documents_after.is_empty(),
            "authorization-unavailable cleanup preserved preview sites: {documents_after:?}"
        );
        assert!(target_stop.load(std::sync::atomic::Ordering::Acquire));
        assert!(unrelated_stop.load(std::sync::atomic::Ordering::Acquire));
        assert_eq!(
            events,
            [
                crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationAcquired,
                crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationReleased,
                crate::path_auth::lock_order_test_probe::LockEvent::HtmlSitesAcquired,
                crate::path_auth::lock_order_test_probe::LockEvent::HtmlSitesReleased,
                crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationAcquired,
                crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationReleased,
                crate::path_auth::lock_order_test_probe::LockEvent::HtmlSitesAcquired,
                crate::path_auth::lock_order_test_probe::LockEvent::HtmlSitesReleased,
            ]
        );
    }

    #[test]
    fn relocate_prefix_relocates_internal_grants_and_invalidates_old_preview_sites() {
        let container = tempdir().unwrap();
        let old_root = container.path().join("old");
        fs::create_dir(&old_root).unwrap();
        let old_document = old_root.join("index.html");
        let old_asset = old_root.join("asset.png");
        fs::write(&old_document, "<img src=\"asset.png\">").unwrap();
        fs::write(&old_asset, b"png").unwrap();
        let canonical_old_root = normalize_existing_path(&old_root).unwrap();
        let canonical_old_document = normalize_existing_path(&old_document).unwrap();
        let state = AppState::default();
        authorize_file_inner(&state, old_document.clone()).unwrap();
        let old_url = prepare_html_preview_inner(&state, &old_document, "old").unwrap();

        let new_root = container.path().join("new");
        fs::rename(&old_root, &new_root).unwrap();
        let canonical_new_root = normalize_existing_path(&new_root).unwrap();
        let new_document = canonical_new_root.join("index.html");
        let new_asset = normalize_existing_path(canonical_new_root.join("asset.png")).unwrap();
        relocate_authorized_path_prefix_inner(&state, &canonical_old_root, &canonical_new_root)
            .unwrap();

        assert!(!state
            .html_preview_server
            .sites
            .lock()
            .unwrap()
            .contains_key(&canonical_old_document));
        assert!(ensure_authorized_existing_file_inner(&state, &new_document).is_ok());
        assert!(is_authorized_image_path(&state, &new_asset).unwrap());

        let new_url = prepare_html_preview_inner(&state, &new_document, "new").unwrap();
        assert_ne!(new_url, old_url);
    }

    #[test]
    fn poisoned_site_map_relocation_retires_unrelated_drained_preview_leases() {
        let workspace = tempdir().unwrap();
        let old_root = workspace.path().join("old");
        fs::create_dir(&old_root).unwrap();
        let target_document = old_root.join("target.html");
        let unrelated_document = workspace.path().join("unrelated.html");
        fs::write(&target_document, "target").unwrap();
        fs::write(&unrelated_document, "unrelated").unwrap();
        let canonical_old_root = normalize_existing_path(&old_root).unwrap();
        let canonical_target_document = normalize_existing_path(&target_document).unwrap();
        let canonical_unrelated_document = normalize_existing_path(&unrelated_document).unwrap();
        let state = AppState::default();
        authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();
        prepare_html_preview_inner(&state, &target_document, "live target").unwrap();
        prepare_html_preview_inner(&state, &unrelated_document, "live unrelated").unwrap();

        let (target_lease, target_stop, unrelated_lease, unrelated_stop) = {
            let sites = state.html_preview_server.sites.lock().unwrap();
            let target = sites.get(&canonical_target_document).unwrap();
            let unrelated = sites.get(&canonical_unrelated_document).unwrap();
            (
                target.lease.clone(),
                target.stop.clone(),
                unrelated.lease.clone(),
                unrelated.stop.clone(),
            )
        };
        assert_eq!(
            state.file_authorization().preview_lease_snapshot().unwrap(),
            HashSet::from([target_lease, unrelated_lease])
        );

        let new_root = workspace.path().join("new");
        fs::rename(&old_root, &new_root).unwrap();
        let canonical_new_root = normalize_existing_path(&new_root).unwrap();
        let poison = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _sites = state.html_preview_server.sites.lock().unwrap();
            panic!("injected HTML site map poison before relocation");
        }));
        assert!(poison.is_err());
        assert!(state.html_preview_server.sites.is_poisoned());

        let (result, events) = crate::path_auth::lock_order_test_probe::trace(|| {
            relocate_authorized_path_prefix_inner(&state, &canonical_old_root, &canonical_new_root)
        });
        let error = result.expect_err("poisoned preview relocation must fail closed");

        assert_eq!(
            error,
            "HTML preview server state was poisoned; all preview sites were stopped"
        );
        assert!(!state.html_preview_server.sites.is_poisoned());
        assert!(state.html_preview_server.sites.lock().unwrap().is_empty());
        assert!(target_stop.load(std::sync::atomic::Ordering::Acquire));
        assert!(unrelated_stop.load(std::sync::atomic::Ordering::Acquire));
        let preview_leases = state.file_authorization().preview_lease_snapshot().unwrap();
        assert!(
            preview_leases.is_empty(),
            "poisoned relocation left drained preview leases authorized: {preview_leases:?}; events={events:?}"
        );
        assert_eq!(
            events,
            [
                crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationAcquired,
                crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationReleased,
                crate::path_auth::lock_order_test_probe::LockEvent::HtmlSitesAcquired,
                crate::path_auth::lock_order_test_probe::LockEvent::HtmlSitesReleased,
                crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationAcquired,
                crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationReleased,
            ]
        );
    }

    #[test]
    fn poisoned_preview_cleanup_after_rename_returns_indeterminate_outcome() {
        let workspace = tempdir().unwrap();
        let source = workspace.path().join("draft.html");
        let target = workspace.path().join("renamed.html");
        fs::write(&source, "draft").unwrap();
        let state = AppState::default();
        let opened = open_directory_inner(&state, workspace.path()).unwrap();
        prepare_html_preview_inner(&state, &source, "live draft").unwrap();
        let canonical_source = normalize_existing_path(&source).unwrap();

        let poison = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _sites = state.html_preview_server.sites.lock().unwrap();
            panic!("injected HTML site map poison before rename cleanup");
        }));
        assert!(poison.is_err());

        let outcome = rename_workspace_entry_inner(
            &state,
            &opened.workspace_token,
            &canonical_source,
            "renamed.html",
        )
        .unwrap();

        let MutationOutcome::Indeterminate {
            operation: MutationKind::Rename,
            paths,
            recovery_message,
        } = outcome
        else {
            panic!("post-commit preview failure must be indeterminate");
        };
        assert_eq!(
            paths,
            [
                canonical_source.to_string_lossy().to_string(),
                target.canonicalize().unwrap().to_string_lossy().to_string(),
            ]
        );
        assert_eq!(
            recovery_message,
            "HTML preview server state was poisoned; all preview sites were stopped"
        );
        assert!(!canonical_source.exists());
        assert!(target.is_file());
        assert!(state
            .file_authorization()
            .preview_lease_snapshot()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn poisoned_site_map_file_revocation_retires_unrelated_drained_preview_leases() {
        let workspace = tempdir().unwrap();
        let target_document = workspace.path().join("target.html");
        let unrelated_document = workspace.path().join("unrelated.html");
        fs::write(&target_document, "target").unwrap();
        fs::write(&unrelated_document, "unrelated").unwrap();
        let canonical_target_document = normalize_existing_path(&target_document).unwrap();
        let canonical_unrelated_document = normalize_existing_path(&unrelated_document).unwrap();
        let state = AppState::default();
        let (authorized_target, ()) = state
            .file_authorization()
            .open_standalone_file(&target_document, |_| Ok(()), |_| Ok(()))
            .unwrap();
        authorize_file_inner(&state, unrelated_document.clone()).unwrap();
        prepare_html_preview_inner(&state, &target_document, "live target").unwrap();
        prepare_html_preview_inner(&state, &unrelated_document, "live unrelated").unwrap();

        let (target_lease, target_stop, unrelated_lease, unrelated_stop) = {
            let sites = state.html_preview_server.sites.lock().unwrap();
            let target = sites.get(&canonical_target_document).unwrap();
            let unrelated = sites.get(&canonical_unrelated_document).unwrap();
            (
                target.lease.clone(),
                target.stop.clone(),
                unrelated.lease.clone(),
                unrelated.stop.clone(),
            )
        };
        assert_eq!(
            state.file_authorization().preview_lease_snapshot().unwrap(),
            HashSet::from([target_lease, unrelated_lease])
        );

        let poison = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _sites = state.html_preview_server.sites.lock().unwrap();
            panic!("injected HTML site map poison before file revocation");
        }));
        assert!(poison.is_err());
        assert!(state.html_preview_server.sites.is_poisoned());

        let (result, events) = crate::path_auth::lock_order_test_probe::trace(|| {
            revoke_authorized_file_inner(&state, &authorized_target)
        });
        let error = result.expect_err("poisoned preview file revocation must fail closed");

        assert_eq!(
            error,
            "HTML preview server state was poisoned; all preview sites were stopped"
        );
        assert!(!state.html_preview_server.sites.is_poisoned());
        assert!(state.html_preview_server.sites.lock().unwrap().is_empty());
        assert!(target_stop.load(std::sync::atomic::Ordering::Acquire));
        assert!(unrelated_stop.load(std::sync::atomic::Ordering::Acquire));
        let preview_leases = state.file_authorization().preview_lease_snapshot().unwrap();
        assert!(
            preview_leases.is_empty(),
            "poisoned file revocation left drained preview leases authorized: {preview_leases:?}; events={events:?}"
        );
        assert_eq!(
            events,
            [
                crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationAcquired,
                crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationReleased,
                crate::path_auth::lock_order_test_probe::LockEvent::HtmlSitesAcquired,
                crate::path_auth::lock_order_test_probe::LockEvent::HtmlSitesReleased,
                crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationAcquired,
                crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationReleased,
            ]
        );
    }

    #[test]
    fn poisoned_site_map_revocation_stops_all_preview_workers() {
        let workspace = tempdir().unwrap();
        let removed_root = workspace.path().join("removed");
        fs::create_dir(&removed_root).unwrap();
        let removed_document = removed_root.join("index.html");
        let retained_document = workspace.path().join("retained.html");
        let search_document = workspace.path().join("search.md");
        fs::write(&removed_document, "removed").unwrap();
        fs::write(&retained_document, "retained").unwrap();
        fs::write(&search_document, "needle").unwrap();
        let canonical_removed_root = normalize_existing_path(&removed_root).unwrap();
        let canonical_removed_document = normalize_existing_path(&removed_document).unwrap();
        let canonical_retained_document = normalize_existing_path(&retained_document).unwrap();
        let state = AppState::default();
        let opened = open_directory_inner(&state, workspace.path()).unwrap();
        rebuild_workspace_index_inner(
            &state,
            &opened.workspace_token,
            &opened.root,
            "poisoned-preview-build",
        )
        .unwrap();
        let canonical_workspace = normalize_existing_path(workspace.path()).unwrap();
        let index_generation = state
            .workspace_index()
            .current_generation(&opened.workspace_token, &canonical_workspace)
            .unwrap()
            .unwrap();
        let query = state
            .workspace_index()
            .begin_query(
                &opened.workspace_token,
                &canonical_workspace,
                "poisoned-preview-query",
            )
            .unwrap();
        prepare_html_preview_inner(&state, &removed_document, "removed").unwrap();
        prepare_html_preview_inner(&state, &retained_document, "retained").unwrap();

        let worker_stops = {
            let sites = state.html_preview_server.sites.lock().unwrap();
            vec![
                sites.get(&canonical_removed_document).unwrap().stop.clone(),
                sites
                    .get(&canonical_retained_document)
                    .unwrap()
                    .stop
                    .clone(),
            ]
        };
        let poison = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _sites = state.html_preview_server.sites.lock().unwrap();
            panic!("injected HTML site map poison");
        }));
        assert!(poison.is_err());
        assert!(state.html_preview_server.sites.is_poisoned());

        let (result, events) = crate::path_auth::lock_order_test_probe::trace(|| {
            revoke_authorized_path_prefix_inner(&state, &canonical_removed_root)
        });
        let error = result.expect_err("poisoned preview revocation must fail closed");

        let workers_stopped = worker_stops
            .iter()
            .all(|stop| stop.load(std::sync::atomic::Ordering::Acquire));
        let sites_empty = state
            .html_preview_server
            .sites
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_empty();
        assert!(
            workers_stopped && sites_empty,
            "poisoned site map did not fail closed: workers_stopped={workers_stopped}, sites_empty={sites_empty}"
        );
        assert!(!state.html_preview_server.sites.is_poisoned());
        assert_eq!(
            error,
            "HTML preview server state was poisoned; all preview sites were stopped"
        );
        assert!(query.lease.cancellation.is_cancelled());
        assert_eq!(
            state
                .workspace_index()
                .current_generation(&opened.workspace_token, &canonical_workspace)
                .unwrap(),
            None
        );
        assert!(!state
            .workspace_index()
            .is_result_current(
                &opened.workspace_token,
                &canonical_workspace,
                index_generation,
            )
            .unwrap());
        let preview_leases = state.file_authorization().preview_lease_snapshot().unwrap();
        assert!(
            preview_leases.is_empty(),
            "poison recovery left preview leases authorized: {preview_leases:?}"
        );
        assert_eq!(
            events,
            [
                crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationAcquired,
                crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationReleased,
                crate::path_auth::lock_order_test_probe::LockEvent::HtmlSitesAcquired,
                crate::path_auth::lock_order_test_probe::LockEvent::HtmlSitesReleased,
                crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationAcquired,
                crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationReleased,
            ]
        );
    }

    #[test]
    fn poisoned_site_map_prepare_retires_drained_and_reserved_preview_leases() {
        let workspace = tempdir().unwrap();
        let old_document = workspace.path().join("old.html");
        let new_document = workspace.path().join("new.html");
        fs::write(&old_document, "saved old").unwrap();
        fs::write(&new_document, "saved new").unwrap();
        let canonical_old_document = normalize_existing_path(&old_document).unwrap();
        let state = AppState::default();
        authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();

        let old_url = prepare_html_preview_inner(&state, &old_document, "live old").unwrap();
        assert!(http_get(&old_url).contains("live old"));
        let old_worker_stop = state
            .html_preview_server
            .sites
            .lock()
            .unwrap()
            .get(&canonical_old_document)
            .unwrap()
            .stop
            .clone();
        assert_eq!(
            state
                .file_authorization()
                .preview_lease_snapshot()
                .unwrap()
                .len(),
            1
        );
        let poison = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _sites = state.html_preview_server.sites.lock().unwrap();
            panic!("injected HTML site map poison before prepare");
        }));
        assert!(poison.is_err());
        assert!(state.html_preview_server.sites.is_poisoned());

        let (result, events) = crate::path_auth::lock_order_test_probe::trace(|| {
            prepare_html_preview_inner(&state, &new_document, "uncommitted new")
        });
        let error = result.expect_err("prepare against poisoned preview state must fail closed");

        assert_eq!(
            error,
            "HTML preview server state was poisoned; all preview sites were stopped"
        );
        assert!(old_worker_stop.load(std::sync::atomic::Ordering::Acquire));
        assert!(!state.html_preview_server.sites.is_poisoned());
        assert!(state.html_preview_server.sites.lock().unwrap().is_empty());
        let preview_leases = state.file_authorization().preview_lease_snapshot().unwrap();
        assert!(
            preview_leases.is_empty(),
            "poisoned prepare left drained or reserved preview leases authorized: {preview_leases:?}"
        );
        assert_eq!(
            events,
            [
                crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationAcquired,
                crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationReleased,
                crate::path_auth::lock_order_test_probe::LockEvent::HtmlSitesAcquired,
                crate::path_auth::lock_order_test_probe::LockEvent::HtmlSitesReleased,
                crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationAcquired,
                crate::path_auth::lock_order_test_probe::LockEvent::AuthorizationReleased,
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn non_utf8_html_path_is_rejected_before_loopback_resources_start() {
        use std::{ffi::OsString, os::unix::ffi::OsStringExt};

        let workspace = tempdir().unwrap();
        let valid_document = workspace.path().join("preview.html");
        fs::write(&valid_document, "saved HTML").unwrap();
        let state = AppState::default();
        authorize_directory_root_inner(&state, workspace.path().to_path_buf()).unwrap();
        let scope =
            crate::path_auth::preview_scope_for_file_inner(&state, &valid_document).unwrap();
        let (_, root, lease) = scope.into_parts();
        let document = root.join(OsString::from_vec(b"preview-\xff.html".to_vec()));
        assert_eq!(
            WorkspaceFileKind::classify(&document),
            Some(WorkspaceFileKind::Html)
        );

        let (result, events) = super::site_start_test_probe::trace(|| {
            super::HtmlPreviewSite::start_parts(
                document,
                root,
                lease.clone(),
                super::HtmlPreviewContent::LiveDraft(std::sync::Arc::new(std::sync::Mutex::new(
                    "uncommitted content".to_string(),
                ))),
            )
        });
        let error = match result {
            Ok(_) => panic!("non-UTF-8 preview path must be rejected"),
            Err(error) => error,
        };
        crate::path_auth::retire_preview_lease_inner(&state, &lease)
            .map_err(crate::path_auth::PreviewRetirementError::into_message)
            .unwrap();

        assert_eq!(error, "HTML preview path is not valid UTF-8");
        assert!(
            events.is_empty(),
            "loopback resources started before path validation: {events:?}"
        );
        assert!(state
            .html_preview_server
            .site_documents()
            .unwrap()
            .is_empty());
        assert!(state
            .file_authorization()
            .preview_lease_snapshot()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn rejects_unauthorized_html_files() {
        let dir = tempdir().unwrap();
        let html = dir.path().join("index.html");
        fs::write(&html, "<h1>Saved</h1>").unwrap();

        let error =
            prepare_html_preview_inner(&AppState::default(), &html, "<h1>Draft</h1>").unwrap_err();

        assert!(error.contains("outside the user-authorized"));
    }

    #[test]
    fn file_authorization_serves_sibling_assets_but_not_parent_traversal() {
        let dir = tempdir().unwrap();
        let site = dir.path().join("site");
        fs::create_dir(&site).unwrap();
        let html = site.join("index.html");
        fs::write(&html, "<h1>Saved</h1>").unwrap();
        fs::write(site.join("app.js"), "window.ok = true;").unwrap();
        fs::write(dir.path().join("secret.txt"), "secret").unwrap();
        let state = AppState::default();
        authorize_file_inner(&state, html.clone()).unwrap();

        let url =
            prepare_html_preview_inner(&state, &html, "<script src=\"app.js\"></script>").unwrap();
        let base = url.rsplit_once('/').unwrap().0;

        assert!(http_get(&format!("{base}/app.js")).starts_with("HTTP/1.1 200"));
        assert!(http_get(&format!("{base}/%2e%2e/secret.txt")).starts_with("HTTP/1.1 403"));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_assets_that_escape_the_preview_root() {
        use std::os::unix::fs::symlink;

        let dir = tempdir().unwrap();
        let site = dir.path().join("site");
        fs::create_dir(&site).unwrap();
        let html = site.join("index.html");
        let secret = dir.path().join("secret.txt");
        fs::write(&html, "<h1>Saved</h1>").unwrap();
        fs::write(&secret, "secret").unwrap();
        symlink(&secret, site.join("secret-link.txt")).unwrap();
        let state = AppState::default();
        authorize_file_inner(&state, html.clone()).unwrap();

        let url = prepare_html_preview_inner(&state, &html, "<h1>Draft</h1>").unwrap();
        let linked_url = format!("{}/secret-link.txt", url.rsplit_once('/').unwrap().0);

        assert!(http_get(&linked_url).starts_with("HTTP/1.1 404"));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_an_opened_file_when_the_request_path_is_swapped_after_open() {
        use std::os::unix::fs::symlink;

        let root = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let secret = outside.path().join("secret.js");
        let requested = root.path().join("asset.js");
        fs::write(&secret, "window.secret = true;").unwrap();
        symlink(&secret, &requested).unwrap();
        let canonical_root = normalize_existing_path(root.path()).unwrap();

        let result = super::open_authorized_file_with(
            &requested,
            &canonical_root,
            || {
                fs::remove_file(&requested).unwrap();
                fs::write(&requested, "window.inside = true;").unwrap();
            },
            || {},
        );

        assert!(result.is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_an_opened_file_when_its_reported_path_is_swapped_before_validation() {
        use std::os::unix::fs::symlink;

        let root = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let inside = root.path().join("inside.js");
        let secret = outside.path().join("secret.js");
        let retained_secret = outside.path().join("retained-secret.js");
        let requested = root.path().join("asset.js");
        fs::write(&inside, "window.inside = true;").unwrap();
        fs::write(&secret, "window.secret = true;").unwrap();
        symlink(&secret, &requested).unwrap();
        let canonical_root = normalize_existing_path(root.path()).unwrap();

        let result = super::open_authorized_file_with(
            &requested,
            &canonical_root,
            || {},
            || {
                fs::rename(&secret, &retained_secret).unwrap();
                symlink(&inside, &secret).unwrap();
            },
        );

        assert!(result.is_err());
    }

    #[test]
    fn rejects_unknown_paths_and_forged_hosts() {
        let dir = tempdir().unwrap();
        let html = dir.path().join("index.html");
        fs::write(&html, "<h1>Saved</h1>").unwrap();
        let state = AppState::default();
        authorize_file_inner(&state, html.clone()).unwrap();
        let url = prepare_html_preview_inner(&state, &html, "<h1>Draft</h1>").unwrap();
        let address = url
            .strip_prefix("http://")
            .unwrap()
            .split('/')
            .next()
            .unwrap();

        assert!(
            http_get(&format!("http://{address}/invalid/index.html")).starts_with("HTTP/1.1 404")
        );

        let response =
            http_request_with_host(address, "index.html", "GET", "attacker.example", &[]);
        assert!(String::from_utf8(response)
            .unwrap()
            .starts_with("HTTP/1.1 421"));
    }

    #[test]
    fn supports_head_and_byte_ranges_for_preview_assets() {
        let dir = tempdir().unwrap();
        let html = dir.path().join("index.html");
        fs::write(&html, "<video src=\"clip.mp4\"></video>").unwrap();
        fs::write(dir.path().join("clip.mp4"), b"0123456789").unwrap();
        let state = AppState::default();
        authorize_file_inner(&state, html.clone()).unwrap();
        let url =
            prepare_html_preview_inner(&state, &html, "<video src=\"clip.mp4\"></video>").unwrap();
        let asset_url = format!("{}/clip.mp4", url.rsplit_once('/').unwrap().0);

        let head = http_request(&asset_url, "HEAD", &[]);
        let head_text = String::from_utf8(head.clone()).unwrap();
        assert!(head_text.starts_with("HTTP/1.1 200"));
        assert!(head_text
            .to_ascii_lowercase()
            .contains("content-length: 10"));
        assert!(response_body(&head).is_empty());

        let range = http_request(&asset_url, "GET", &[("Range", "bytes=2-5")]);
        let headers = String::from_utf8_lossy(&range[..range.len() - response_body(&range).len()]);
        assert!(headers.starts_with("HTTP/1.1 206"));
        assert!(headers
            .to_ascii_lowercase()
            .contains("content-range: bytes 2-5/10"));
        assert_eq!(response_body(&range), b"2345");
    }
}
