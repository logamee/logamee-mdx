use super::fixtures2::*;
use super::fixtures3::*;

#[test]
fn pdf_and_docx_open_responses_have_exact_binary_wire_shapes() {
    let directory = tempdir().unwrap();
    let pdf_path = directory.path().join("report.pdf");
    let docx_path = directory.path().join("report.docx");
    let image_path = directory.path().join("pixel.png");
    let pdf = b"%PDF-1.7\n%%EOF\n";
    let docx = minimal_docx_zip();
    fs::write(&pdf_path, pdf).unwrap();
    fs::write(&docx_path, &docx).unwrap();
    fs::write(&image_path, [0x89, b'P', b'N', b'G']).unwrap();

    assert_exact_binary_wire(&pdf_path, pdf, "pdf", "application/pdf");
    assert_exact_binary_wire(
        &docx_path,
        &docx,
        "docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );

    let state = AppState::default();
    authorize_directory_root_inner(&state, directory.path().to_path_buf()).unwrap();
    let image =
        serde_json::to_value(open_workspace_file_inner(&state, &image_path).unwrap()).unwrap();
    assert!(image.get("bytes_base64").is_none());
    assert!(image.get("content").is_none());
}
#[test]
fn workspace_snapshot_includes_pdf_and_docx_with_binary_kinds() {
    let directory = tempdir().unwrap();
    fs::write(directory.path().join("a.pdf"), b"%PDF-1.7\n%%EOF\n").unwrap();
    fs::write(directory.path().join("b.docx"), minimal_docx_zip()).unwrap();
    fs::write(directory.path().join("ignored.zip"), b"PK").unwrap();

    let snapshot = open_directory_inner(&AppState::default(), directory.path()).unwrap();
    let entries = snapshot
        .files
        .iter()
        .map(|entry| {
            (
                entry.relative_path.as_str(),
                serde_json::to_value(entry.kind).unwrap(),
            )
        })
        .collect::<Vec<_>>();

    assert_eq!(
        entries,
        [
            ("a.pdf", serde_json::json!("pdf")),
            ("b.docx", serde_json::json!("docx")),
        ]
    );
}
#[test]
fn standalone_file_parent_workspace_uses_the_authorized_file_parent() {
    let directory = tempdir().unwrap();
    let nested = directory.path().join("notes");
    fs::create_dir(&nested).unwrap();
    let file = nested.join("current.md");
    fs::write(&file, "# Current").unwrap();
    let state = AppState::default();
    open_standalone_file_with_ports_inner(
        &state,
        &file,
        |path| open_authorized_file_response(path.to_path_buf()),
        |_| Ok(()),
    )
    .unwrap();

    let snapshot = open_file_parent_directory_inner(&state, &file).unwrap();

    assert_eq!(
        snapshot.root,
        nested.canonicalize().unwrap().to_string_lossy()
    );
    assert!(snapshot
        .files
        .iter()
        .any(|entry| entry.path == file.canonicalize().unwrap().to_string_lossy()));
}
#[test]
fn standalone_file_parent_workspace_rejects_an_unauthorized_file() {
    let directory = tempdir().unwrap();
    let file = directory.path().join("current.md");
    fs::write(&file, "# Current").unwrap();
    let state = AppState::default();

    let error = open_file_parent_directory_inner(&state, &file).unwrap_err();

    assert!(error.contains("outside the user-authorized session files and directories"));
}
#[test]
fn pdf_and_docx_source_limits_reject_before_exact_grant_publication() {
    let directory = tempdir().unwrap();
    let cases = [
        ("oversized.pdf", P2_PDF_SOURCE_LIMIT + 1, "64 MiB"),
        ("oversized.docx", P2_DOCX_SOURCE_LIMIT + 1, "32 MiB"),
    ];

    for (name, length, expected_message) in cases {
        let path = directory.path().join(name);
        let file = fs::File::create(&path).unwrap();
        file.set_len(length).unwrap();
        let state = AppState::default();
        authorize_directory_root_inner(&state, directory.path().to_path_buf()).unwrap();

        let error = open_workspace_file_inner(&state, &path).unwrap_err();

        assert!(
            error.contains(expected_message),
            "expected {error:?} to contain {expected_message:?}"
        );
        assert!(ensure_authorized_write_file_inner(&state, &path).is_err());
    }
}
#[test]
fn docx_preflight_rejects_malformed_and_truncated_central_directories() {
    assert_docx_open_rejected_without_exact_grant(b"PK\x03\x04truncated", "malformed or truncated");

    let mut truncated = minimal_docx_zip();
    truncated.truncate(truncated.len() - 8);
    assert_docx_open_rejected_without_exact_grant(&truncated, "malformed or truncated");
}
#[test]
fn docx_preflight_rejects_more_than_ten_thousand_entries() {
    let entries = (0..10_001)
        .map(|index| TestZipEntry::new(format!("word/item-{index}.xml"), 0, 0))
        .collect::<Vec<_>>();
    let bytes = docx_zip(&entries, true);

    assert_zip_central_directory_parses(&bytes, 10_001);
    assert_docx_open_rejected_without_exact_grant(&bytes, "10,000");
}
#[test]
fn docx_preflight_rejects_declared_expansion_over_one_hundred_twenty_eight_mib() {
    let bytes = docx_zip(
        &[TestZipEntry::new(
            "word/document.xml",
            2 * 1024 * 1024,
            128 * 1024 * 1024 + 1,
        )],
        true,
    );

    assert_zip_central_directory_parses(&bytes, 1);
    assert_docx_open_rejected_without_exact_grant(&bytes, "128 MiB");
}
#[test]
fn docx_preflight_rejects_zero_compressed_nonzero_output_and_ratio_above_one_hundred() {
    let zero_compressed = docx_zip(&[TestZipEntry::new("word/document.xml", 0, 1)], true);
    assert_zip_central_directory_parses(&zero_compressed, 1);
    assert_docx_open_rejected_without_exact_grant(&zero_compressed, "zero compressed bytes");

    let excessive_ratio = docx_zip(&[TestZipEntry::new("word/document.xml", 1, 101)], true);
    assert_zip_central_directory_parses(&excessive_ratio, 1);
    assert_docx_open_rejected_without_exact_grant(&excessive_ratio, "100:1");
}
#[test]
fn docx_preflight_rejects_checked_size_overflow() {
    let bytes = docx_zip(
        &[
            TestZipEntry::new("word/one.bin", u64::MAX, u64::MAX),
            TestZipEntry::new("word/two.bin", u64::MAX, u64::MAX),
        ],
        true,
    );

    assert_zip_central_directory_parses(&bytes, 2);
    assert_docx_open_rejected_without_exact_grant(&bytes, "overflow");
}
#[test]
fn docx_preflight_uses_central_directory_without_opening_entry_bodies() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("central-only.docx");
    let bytes = docx_zip(
        &[TestZipEntry::new("word/document.xml", 0, 0).with_compression_method(8)],
        true,
    );
    assert_zip_central_directory_parses(&bytes, 1);
    fs::write(&path, &bytes).unwrap();
    let state = AppState::default();
    authorize_directory_root_inner(&state, directory.path().to_path_buf()).unwrap();

    let response = open_workspace_file_inner(&state, &path).unwrap();

    let value = serde_json::to_value(response).unwrap();
    assert_eq!(value["kind"], "docx");
    assert_eq!(value["bytes_base64"], test_base64(&bytes));
}
#[test]
fn binary_prepare_finishes_response_before_exact_grant_commit() {
    let directory = tempdir().unwrap();
    let recent_directory = tempdir().unwrap();
    let path = directory.path().join("report.docx");
    fs::write(&path, minimal_docx_zip()).unwrap();
    let state = AppState::default();
    state
        .initialize_recent_files(recent_directory.path().to_path_buf())
        .unwrap();
    authorize_directory_root_inner(&state, directory.path().to_path_buf()).unwrap();

    let prepared = prepare_workspace_file_inner(&state, "main", &path).unwrap();

    assert!(ensure_authorized_write_file_inner(&state, &path).is_err());
    let committed = state
        .recent_files()
        .unwrap()
        .commit_open(&prepared.open_receipt, "main", state.file_authorization())
        .unwrap();
    assert!(matches!(committed, OpenCommitResult::Committed { .. }));
    assert!(ensure_authorized_write_file_inner(&state, &path).is_ok());
}
#[test]
fn pdf_and_docx_reject_text_read_write_save_as_and_rename() {
    let directory = tempdir().unwrap();
    let fixtures = [
        ("report.pdf", b"%PDF-1.7\n%%EOF\n".to_vec()),
        ("report.docx", minimal_docx_zip()),
    ];
    for (name, bytes) in &fixtures {
        fs::write(directory.path().join(name), bytes).unwrap();
    }
    let state = AppState::default();
    let workspace = open_directory_inner(&state, directory.path()).unwrap();

    for (name, original) in fixtures {
        let path = directory.path().join(name);
        open_workspace_file_inner(&state, &path).unwrap();

        assert_eq!(
            read_file_inner(&state, &path).unwrap_err(),
            "Only Markdown, HTML, and Excalidraw files can be read as text"
        );
        assert_confirmed_not_committed(write_file_inner(&state, &path, "replacement"));
        assert_confirmed_not_committed(save_as_inner(&state, &path, "replacement".to_string()));
        assert_confirmed_not_committed(rename_workspace_entry_inner(
            &state,
            &workspace.workspace_token,
            &path,
            &format!(
                "renamed.{extension}",
                extension = Path::new(name).extension().unwrap().to_string_lossy()
            ),
        ));
        assert_eq!(fs::read(&path).unwrap(), original);
        assert!(
            directory
                .path()
                .join(format!(
                    "renamed.{extension}",
                    extension = Path::new(name).extension().unwrap().to_string_lossy()
                ))
                .exists()
                == false
        );
    }
}
