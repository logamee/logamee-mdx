use std::{
    env, fs,
    fs::OpenOptions,
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::State;

use crate::{commands::open_directory_inner, models::WorkspaceSnapshot, state::AppState};

const SCHEMA: u32 = 1;
const NONCE_LENGTH: usize = 64;
const CONTAINER_ROOT_NAME: &str = "mmd-packaged-lifecycle-e2e";

#[derive(Debug, Serialize)]
pub(crate) struct PackagedLifecycleE2ePaths {
    save_success: PathBuf,
    save_stale: PathBuf,
    control: PathBuf,
    trash_file: PathBuf,
    trash_directory: PathBuf,
    receipt: PathBuf,
}

impl PackagedLifecycleE2ePaths {
    fn under(root: &Path) -> Self {
        Self {
            save_success: root.join("save-success.md"),
            save_stale: root.join("save-stale.md"),
            control: root.join("control.md"),
            trash_file: root.join("trash-file.md"),
            trash_directory: root.join("trash-dir"),
            receipt: root.join("receipt.md"),
        }
    }
}

#[derive(Debug, Serialize)]
pub(crate) struct PackagedLifecycleE2eSetup {
    schema: u32,
    nonce: String,
    workflow: PackagedLifecycleE2eWorkflow,
    package_variant: String,
    current_exe_sha256: String,
    workspace: WorkspaceSnapshot,
    paths: PackagedLifecycleE2ePaths,
}

#[derive(Debug, Serialize)]
struct PackagedLifecycleE2eWorkflow {
    run_id: String,
    run_attempt: String,
    commit: String,
    target: String,
}

#[derive(Clone, Debug)]
struct RuntimeIdentity {
    run_id: String,
    run_attempt: String,
    commit: String,
    target: String,
    package_variant: String,
    current_exe_sha256: String,
}

fn required_env(primary: &str, fallback: Option<&str>) -> Result<String, String> {
    env::var(primary)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            fallback.and_then(|name| env::var(name).ok().filter(|value| !value.trim().is_empty()))
        })
        .ok_or_else(|| format!("Packaged lifecycle E2E requires {primary}"))
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path)
        .map_err(|error| format!("Cannot open packaged lifecycle executable: {error}"))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("Cannot hash packaged lifecycle executable: {error}"))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

impl RuntimeIdentity {
    fn from_environment() -> Result<Self, String> {
        let current_exe = env::current_exe()
            .map_err(|error| format!("Cannot locate packaged lifecycle executable: {error}"))?;
        Ok(Self {
            run_id: required_env("MMD_PACKAGED_LIFECYCLE_E2E_RUN_ID", Some("GITHUB_RUN_ID"))?,
            run_attempt: required_env(
                "MMD_PACKAGED_LIFECYCLE_E2E_RUN_ATTEMPT",
                Some("GITHUB_RUN_ATTEMPT"),
            )?,
            commit: required_env("MMD_PACKAGED_LIFECYCLE_E2E_COMMIT", Some("GITHUB_SHA"))?,
            target: required_env("MMD_PACKAGED_LIFECYCLE_E2E_TARGET", None)?,
            package_variant: required_env("MMD_PACKAGED_LIFECYCLE_E2E_VARIANT", None)?,
            current_exe_sha256: sha256_file(&current_exe)?,
        })
    }
}

fn validate_nonce(nonce: &str) -> Result<(), String> {
    if nonce.len() == NONCE_LENGTH
        && nonce
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Ok(());
    }
    Err("Packaged lifecycle E2E nonce must be 64 lowercase hexadecimal characters".to_string())
}

#[cfg(unix)]
fn create_private_workspace(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;

    let mut builder = fs::DirBuilder::new();
    builder.mode(0o700).create(path)
}

#[cfg(windows)]
fn create_private_workspace(path: &Path) -> io::Result<()> {
    fs::create_dir(path)?;
    crate::crash_drafts::make_directory_private(path)?;
    verify_windows_directory_owner(path)?;
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn create_private_workspace(_path: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "private directory creation is unavailable",
    ))
}

#[cfg(windows)]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

#[cfg(unix)]
fn existing_container_is_private(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;

    metadata.uid() == unsafe { libc::geteuid() } && metadata.mode() & 0o077 == 0
}

#[cfg(windows)]
fn secure_existing_container(path: &Path) -> io::Result<()> {
    verify_windows_directory_owner(path)?;
    crate::crash_drafts::make_directory_private(path)?;
    verify_windows_directory_owner(path)
}

#[cfg(windows)]
fn current_process_token_information(
    information_class: windows_sys::Win32::Security::TOKEN_INFORMATION_CLASS,
) -> io::Result<Vec<usize>> {
    use std::{mem, ptr};
    use windows_sys::Win32::{Foundation::HANDLE, Security::GetTokenInformation};

    // The process-token pseudo handle is supported by Windows 8 and later.
    const CURRENT_PROCESS_TOKEN: HANDLE = (-4_isize) as HANDLE;
    let mut token_size = 0u32;
    unsafe {
        GetTokenInformation(
            CURRENT_PROCESS_TOKEN,
            information_class,
            ptr::null_mut(),
            0,
            &mut token_size,
        );
    }
    if token_size == 0 {
        return Err(io::Error::last_os_error());
    }
    let word_size = mem::size_of::<usize>();
    let mut token = vec![0usize; (token_size as usize).div_ceil(word_size)];
    if unsafe {
        GetTokenInformation(
            CURRENT_PROCESS_TOKEN,
            information_class,
            token.as_mut_ptr().cast(),
            token_size,
            &mut token_size,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(token)
}

#[cfg(windows)]
fn verify_windows_directory_owner(path: &Path) -> io::Result<()> {
    use std::{mem, os::windows::ffi::OsStrExt, ptr};
    use windows_sys::Win32::Security::{
        EqualSid, GetFileSecurityW, GetSecurityDescriptorOwner, TokenOwner, TokenUser,
        OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, TOKEN_OWNER, TOKEN_USER,
    };

    let wide_path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut security_size = 0u32;
    unsafe {
        GetFileSecurityW(
            wide_path.as_ptr(),
            OWNER_SECURITY_INFORMATION,
            ptr::null_mut(),
            0,
            &mut security_size,
        );
    }
    if security_size == 0 {
        return Err(io::Error::last_os_error());
    }
    let word_size = mem::size_of::<usize>();
    let mut security = vec![0usize; (security_size as usize).div_ceil(word_size)];
    if unsafe {
        GetFileSecurityW(
            wide_path.as_ptr(),
            OWNER_SECURITY_INFORMATION,
            security.as_mut_ptr().cast(),
            security_size,
            &mut security_size,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let descriptor: PSECURITY_DESCRIPTOR = security.as_mut_ptr().cast();
    let mut owner = ptr::null_mut();
    let mut owner_defaulted = 0;
    if unsafe { GetSecurityDescriptorOwner(descriptor, &mut owner, &mut owner_defaulted) } == 0
        || owner.is_null()
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "private directory owner could not be verified",
        ));
    }

    let token_user = current_process_token_information(TokenUser)?;
    let token_user = unsafe { &*token_user.as_ptr().cast::<TOKEN_USER>() };
    let token_owner = current_process_token_information(TokenOwner)?;
    let token_owner = unsafe { &*token_owner.as_ptr().cast::<TOKEN_OWNER>() };
    if unsafe { EqualSid(owner, token_user.User.Sid) } == 0
        && unsafe { EqualSid(owner, token_owner.Owner) } == 0
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "private directory owner is outside the current process token",
        ));
    }
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn secure_existing_container(_path: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "private directory verification is unavailable",
    ))
}

fn ensure_fixed_container_root(temp_root: &Path) -> Result<PathBuf, String> {
    let container_root = temp_root.join(CONTAINER_ROOT_NAME);
    match fs::symlink_metadata(&container_root) {
        Ok(metadata) => {
            if !metadata.is_dir()
                || metadata.file_type().is_symlink()
                || is_reparse_point(&metadata)
            {
                return Err(
                    "Packaged lifecycle E2E container root is not a private directory".to_string(),
                );
            }
            #[cfg(unix)]
            if !existing_container_is_private(&metadata) {
                return Err(
                    "Packaged lifecycle E2E container root is not a private directory".to_string(),
                );
            }
            #[cfg(not(unix))]
            secure_existing_container(&container_root).map_err(|_| {
                "Packaged lifecycle E2E container root is not a private directory".to_string()
            })?;
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            create_private_workspace(&container_root).map_err(|_| {
                "Packaged lifecycle E2E container root is not a private directory".to_string()
            })?;
        }
        Err(_) => {
            return Err(
                "Packaged lifecycle E2E container root is not a private directory".to_string(),
            );
        }
    }
    Ok(container_root)
}

fn create_fixture(path: &Path, content: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| format!("Cannot create packaged lifecycle fixture: {error}"))?;
    file.write_all(content)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("Cannot persist packaged lifecycle fixture: {error}"))
}

fn setup_packaged_lifecycle_e2e_at(
    state: &AppState,
    temp_root: &Path,
    nonce: &str,
    identity: RuntimeIdentity,
) -> Result<PackagedLifecycleE2eSetup, String> {
    validate_nonce(nonce)?;
    let container_root = ensure_fixed_container_root(temp_root)?;
    let run_root = container_root.join(nonce);
    match create_private_workspace(&run_root) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            return Err("Packaged lifecycle E2E workspace already exists".to_string());
        }
        Err(error) => {
            return Err(format!(
                "Cannot create packaged lifecycle E2E workspace: {error}"
            ));
        }
    }
    let root = run_root.join("workspace");
    if let Err(error) = create_private_workspace(&root) {
        let _ = fs::remove_dir_all(&run_root);
        return Err(format!(
            "Cannot create packaged lifecycle E2E workspace: {error}"
        ));
    }

    let result = (|| {
        let paths = PackagedLifecycleE2ePaths::under(&root);
        create_fixture(&paths.save_success, b"# Save success\nfixture-v1\n")?;
        create_fixture(&paths.save_stale, b"# Save stale\nfixture-v1\n")?;
        create_fixture(&paths.control, b"waiting\n")?;
        create_fixture(&paths.trash_file, b"trash-file-v1\n")?;
        create_private_workspace(&paths.trash_directory)
            .map_err(|error| format!("Cannot create packaged lifecycle fixture: {error}"))?;
        create_fixture(
            &paths.trash_directory.join("child.md"),
            b"trash-directory-v1\n",
        )?;
        create_fixture(&paths.receipt, b"")?;
        let workspace = open_directory_inner(state, &root)?;
        let paths = PackagedLifecycleE2ePaths::under(Path::new(&workspace.root));
        Ok(PackagedLifecycleE2eSetup {
            schema: SCHEMA,
            nonce: nonce.to_string(),
            workflow: PackagedLifecycleE2eWorkflow {
                run_id: identity.run_id,
                run_attempt: identity.run_attempt,
                commit: identity.commit,
                target: identity.target,
            },
            package_variant: identity.package_variant,
            current_exe_sha256: identity.current_exe_sha256,
            workspace,
            paths,
        })
    })();

    if result.is_err() {
        let _ = fs::remove_dir_all(&run_root);
    }
    result
}

#[tauri::command]
pub(crate) fn setup_packaged_lifecycle_e2e(
    state: State<'_, AppState>,
) -> Result<PackagedLifecycleE2eSetup, String> {
    let nonce = required_env("MMD_PACKAGED_LIFECYCLE_E2E_NONCE", None)?;
    let identity = RuntimeIdentity::from_environment()?;
    setup_packaged_lifecycle_e2e_at(&state, &env::temp_dir(), &nonce, identity)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use super::*;

    #[test]
    fn rejects_noncanonical_nonce_without_creating_a_workspace() {
        let temp = TempDir::new().unwrap();

        for nonce in [
            "../escape",
            "0123456789abcdef0123456789abcde",
            "0123456789abcdef0123456789abcdeF",
            "0123456789abcdef/123456789abcdef",
            "0123456789abcdef0123456789abcdeg",
        ] {
            let error = setup_packaged_lifecycle_e2e_at(
                &crate::state::AppState::default(),
                temp.path(),
                nonce,
                RuntimeIdentity::default_for_test(),
            )
            .unwrap_err();

            assert_eq!(
                error,
                "Packaged lifecycle E2E nonce must be 64 lowercase hexadecimal characters"
            );
        }
        assert!(fs::read_dir(temp.path()).unwrap().next().is_none());
    }

    #[test]
    fn creates_fixed_fixtures_and_serializes_the_public_schema() {
        let temp = TempDir::new().unwrap();
        let nonce = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

        let response = setup_packaged_lifecycle_e2e_at(
            &crate::state::AppState::default(),
            temp.path(),
            nonce,
            RuntimeIdentity {
                run_id: "run-42".to_string(),
                run_attempt: "3".to_string(),
                commit: "abc123".to_string(),
                target: "aarch64-apple-darwin".to_string(),
                package_variant: "dmg".to_string(),
                current_exe_sha256: "f".repeat(64),
            },
        )
        .unwrap();

        assert_eq!(
            fs::read_to_string(&response.paths.save_success).unwrap(),
            "# Save success\nfixture-v1\n"
        );
        assert_eq!(
            fs::read_to_string(&response.paths.save_stale).unwrap(),
            "# Save stale\nfixture-v1\n"
        );
        assert_eq!(
            fs::read_to_string(&response.paths.control).unwrap(),
            "waiting\n"
        );
        assert_eq!(
            fs::read_to_string(&response.paths.trash_file).unwrap(),
            "trash-file-v1\n"
        );
        assert_eq!(
            fs::read_to_string(response.paths.trash_directory.join("child.md")).unwrap(),
            "trash-directory-v1\n"
        );
        assert_eq!(fs::read_to_string(&response.paths.receipt).unwrap(), "");
        assert_eq!(
            response.paths.save_success.parent().unwrap(),
            Path::new(&response.workspace.root)
        );
        assert_eq!(
            response.paths.save_success.parent().unwrap(),
            temp.path()
                .canonicalize()
                .unwrap()
                .join("mmd-packaged-lifecycle-e2e")
                .join(nonce)
                .join("workspace")
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;

            let container_metadata = fs::metadata(
                temp.path()
                    .join("mmd-packaged-lifecycle-e2e")
                    .canonicalize()
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(container_metadata.uid(), unsafe { libc::geteuid() });
            assert_eq!(container_metadata.mode() & 0o077, 0);
        }

        let value = serde_json::to_value(response).unwrap();
        let mut top_level_keys: Vec<_> = value.as_object().unwrap().keys().cloned().collect();
        top_level_keys.sort();
        assert_eq!(
            top_level_keys,
            [
                "current_exe_sha256",
                "nonce",
                "package_variant",
                "paths",
                "schema",
                "workflow",
                "workspace",
            ]
        );
        assert_eq!(value["schema"], 1);
        assert_eq!(value["nonce"], nonce);
        assert_eq!(
            value["workflow"],
            serde_json::json!({
                "run_id": "run-42",
                "run_attempt": "3",
                "commit": "abc123",
                "target": "aarch64-apple-darwin",
            })
        );
        assert_eq!(value["package_variant"], "dmg");
        assert_eq!(value["current_exe_sha256"], "f".repeat(64));
        let mut workspace_keys: Vec<_> = value["workspace"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        workspace_keys.sort();
        assert_eq!(
            workspace_keys,
            ["directories", "files", "root", "workspace_token"]
        );
        assert!(value["workspace"]["workspace_token"].is_string());
        let mut path_keys: Vec<_> = value["paths"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        path_keys.sort();
        assert_eq!(
            path_keys,
            [
                "control",
                "receipt",
                "save_stale",
                "save_success",
                "trash_directory",
                "trash_file",
            ]
        );
        assert!(value["paths"]["save_success"].is_string());
        assert!(value["paths"]["save_stale"].is_string());
        assert!(value["paths"]["control"].is_string());
        assert!(value["paths"]["trash_file"].is_string());
        assert!(value["paths"]["trash_directory"].is_string());
        assert!(value["paths"]["receipt"].is_string());
        for removed_flattened_field in ["run_id", "run_attempt", "commit", "target"] {
            assert!(value.get(removed_flattened_field).is_none());
        }
    }

    #[test]
    fn refuses_to_reuse_a_nonce_workspace() {
        let temp = TempDir::new().unwrap();
        let nonce = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
        let state = crate::state::AppState::default();
        setup_packaged_lifecycle_e2e_at(
            &state,
            temp.path(),
            nonce,
            RuntimeIdentity::default_for_test(),
        )
        .unwrap();

        let error = setup_packaged_lifecycle_e2e_at(
            &state,
            temp.path(),
            nonce,
            RuntimeIdentity::default_for_test(),
        )
        .unwrap_err();

        assert_eq!(error, "Packaged lifecycle E2E workspace already exists");
    }

    #[cfg(windows)]
    #[test]
    fn accepts_a_private_container_created_with_the_process_default_owner() {
        let temp = TempDir::new().unwrap();
        let container = temp.path().join(CONTAINER_ROOT_NAME);

        create_private_workspace(&container).unwrap();

        assert_eq!(ensure_fixed_container_root(temp.path()).unwrap(), container);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlinked_fixed_container_root() {
        use std::os::unix::fs::symlink;

        let temp = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        symlink(
            outside.path(),
            temp.path().join("mmd-packaged-lifecycle-e2e"),
        )
        .unwrap();

        let error = setup_packaged_lifecycle_e2e_at(
            &crate::state::AppState::default(),
            temp.path(),
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            RuntimeIdentity::default_for_test(),
        )
        .unwrap_err();

        assert_eq!(
            error,
            "Packaged lifecycle E2E container root is not a private directory"
        );
        assert!(fs::read_dir(outside.path()).unwrap().next().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_an_existing_fixed_container_with_group_or_other_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let temp = TempDir::new().unwrap();
        let container = temp.path().join("mmd-packaged-lifecycle-e2e");
        fs::create_dir(&container).unwrap();
        fs::set_permissions(&container, fs::Permissions::from_mode(0o750)).unwrap();

        let error = setup_packaged_lifecycle_e2e_at(
            &crate::state::AppState::default(),
            temp.path(),
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            RuntimeIdentity::default_for_test(),
        )
        .unwrap_err();

        assert_eq!(
            error,
            "Packaged lifecycle E2E container root is not a private directory"
        );
        assert!(fs::read_dir(&container).unwrap().next().is_none());
    }

    impl RuntimeIdentity {
        fn default_for_test() -> Self {
            Self {
                run_id: "run".to_string(),
                run_attempt: "1".to_string(),
                commit: "commit".to_string(),
                target: "target".to_string(),
                package_variant: "variant".to_string(),
                current_exe_sha256: "0".repeat(64),
            }
        }
    }
}
