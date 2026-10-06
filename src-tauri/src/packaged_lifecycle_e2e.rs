use std::{
    env, fs,
    fs::OpenOptions,
    io::{self, Read, Write},
    path::{Path, PathBuf},
};
use crate::private_fs::lowercase_hex;

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
    Ok(lowercase_hex(&digest.finalize()))
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

mod security;

#[cfg(unix)]
use security::{create_private_workspace, existing_container_is_private, is_reparse_point};
#[cfg(not(unix))]
use security::{create_private_workspace, is_reparse_point, secure_existing_container};

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
mod tests;
