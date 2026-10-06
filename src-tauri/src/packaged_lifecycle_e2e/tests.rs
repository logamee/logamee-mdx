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

    assert_fixture_files(&response);
    assert_workspace_anchor(&response, temp.path(), nonce);
    assert_container_is_private(temp.path());
    assert_public_schema_json(&response, nonce);
}

fn assert_fixture_files(response: &PackagedLifecycleE2eSetup) {
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
}

fn assert_workspace_anchor(response: &PackagedLifecycleE2eSetup, temp_root: &Path, nonce: &str) {
    assert_eq!(
        response.paths.save_success.parent().unwrap(),
        Path::new(&response.workspace.root)
    );
    assert_eq!(
        response.paths.save_success.parent().unwrap(),
        temp_root
            .canonicalize()
            .unwrap()
            .join("mmd-packaged-lifecycle-e2e")
            .join(nonce)
            .join("workspace")
    );
}

fn assert_container_is_private(temp_root: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;

        let container_metadata = fs::metadata(
            temp_root
                .join("mmd-packaged-lifecycle-e2e")
                .canonicalize()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(container_metadata.uid(), unsafe { libc::geteuid() });
        assert_eq!(container_metadata.mode() & 0o077, 0);
    }
    #[cfg(not(unix))]
    {
        let _ = temp_root;
    }
}

fn assert_public_schema_json(response: &PackagedLifecycleE2eSetup, nonce: &str) {
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
    assert_workspace_schema_shape(&value);
    assert_paths_schema_shape(&value);
    for removed_flattened_field in ["run_id", "run_attempt", "commit", "target"] {
        assert!(value.get(removed_flattened_field).is_none());
    }
}

fn assert_workspace_schema_shape(value: &serde_json::Value) {
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
}

fn assert_paths_schema_shape(value: &serde_json::Value) {
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
