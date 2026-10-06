use super::trash_fixtures::*;

#[derive(Clone, Copy, Debug)]
enum InvalidEvidence {
    WrongKind,
    WrongCanonical,
}

struct InvalidNewOnlyEvidencePort {
    source: PathBuf,
    target: PathBuf,
    unrelated: PathBuf,
    evidence: InvalidEvidence,
}

impl FileSystemPort for InvalidNewOnlyEvidencePort {
    fn write(&self, _path: &Path, _bytes: &[u8]) -> std::io::Result<()> {
        unreachable!("rename evidence test must not write files")
    }

    fn create_new(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("rename evidence test must not create files")
    }

    fn create_dir(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("rename evidence test must not create directories")
    }

    fn rename(&self, from: &Path, to: &Path) -> std::io::Result<()> {
        fs::rename(from, to)?;
        Err(std::io::Error::other("injected post-rename failure"))
    }

    fn remove_file(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("rename evidence test must not delete files")
    }

    fn remove_dir_all(&self, _path: &Path) -> std::io::Result<()> {
        unreachable!("rename evidence test must not delete directories")
    }

    fn observe(&self, path: &Path, expected_bytes: Option<&[u8]>) -> std::io::Result<ObservedPath> {
        assert!(expected_bytes.is_none());
        if path == self.source {
            return Ok(ObservedPath::Missing);
        }
        assert_eq!(path, self.target);
        Ok(ObservedPath::Present {
            canonical_path: Some(match self.evidence {
                InvalidEvidence::WrongKind => self.target.clone(),
                InvalidEvidence::WrongCanonical => self.unrelated.clone(),
            }),
            kind: match self.evidence {
                InvalidEvidence::WrongKind => ObservedPathKind::Directory,
                InvalidEvidence::WrongCanonical => ObservedPathKind::File,
            },
            content: ObservedContentEvidence::NotRequested,
        })
    }
}

#[test]
fn rename_new_only_requires_matching_kind_and_canonical_destination() {
    for evidence in [InvalidEvidence::WrongKind, InvalidEvidence::WrongCanonical] {
        let workspace = tempdir().unwrap();
        let source = workspace.path().join("draft.md");
        let unrelated = workspace.path().join("unrelated.md");
        fs::write(&source, "draft").unwrap();
        fs::write(&unrelated, "unrelated").unwrap();

        let state = AppState::default();
        let opened = open_directory_inner(&state, workspace.path()).unwrap();
        open_workspace_file_inner(&state, &source).unwrap();
        let canonical_source = source.canonicalize().unwrap();
        let canonical_target = workspace.path().canonicalize().unwrap().join("archive.md");
        let canonical_unrelated = unrelated.canonicalize().unwrap();
        let snapshot_calls = Cell::new(0);
        let filesystem = InvalidNewOnlyEvidencePort {
            source: canonical_source.clone(),
            target: canonical_target.clone(),
            unrelated: canonical_unrelated,
            evidence,
        };

        let outcome = rename_workspace_entry_with_ports_inner(
            &state,
            &opened.workspace_token,
            &canonical_source,
            "archive.md",
            &filesystem,
            |_source| {
                snapshot_calls.set(snapshot_calls.get() + 1);
                Err("snapshot must not run for invalid rename evidence".to_string())
            },
        )
        .unwrap();

        assert!(
            matches!(outcome, MutationOutcome::Indeterminate { .. }),
            "{evidence:?}",
        );
        assert_eq!(snapshot_calls.get(), 0, "{evidence:?}");
        assert_eq!(
            state
                .file_authorization()
                .exact_write_grant_snapshot_for_test(&canonical_source)
                .unwrap()
                .map(|(status, _)| status),
            Some(GrantStatus::Suspended),
            "{evidence:?}",
        );
    }
}
