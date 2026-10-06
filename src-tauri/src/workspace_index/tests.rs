use super::*;
pub(crate) fn document(path: &str, content: &str) -> IndexDocument {
    IndexDocument {
        relative_path: path.to_owned(),
        content: content.to_owned(),
    }
}


#[test]
fn builds_deterministically_and_reports_identity_digest_and_limits() {
    let documents = vec![
        document("zeta.md", "Shared needle"),
        document("alpha.md", "Shared needle"),
    ];
    let limits = IndexLimits::default();

    let first = build_index(documents.clone(), limits, &CancellationToken::new());
    let second = build_index(documents, limits, &CancellationToken::new());
    let (first_index, first_report) = first.completed().unwrap();
    let (second_index, second_report) = second.completed().unwrap();

    assert_eq!(first_report, second_report);
    assert_eq!(first_report.implementation_id, INDEX_IMPLEMENTATION_ID);
    assert_eq!(first_report.schema_id, INDEX_SCHEMA_ID);
    assert!(first_report.corpus_digest.starts_with("sha256-v1:"));
    assert_eq!(first_report.limits, limits);
    assert_eq!(
        first_index.normalized_documents(),
        second_index.normalized_documents()
    );
}

#[test]
fn keeps_case_distinct_paths_as_separate_filesystem_identities() {
    let (index, report) = build_index(
        vec![
            document("A/note.md", "upper"),
            document("a/note.md", "lower"),
        ],
        IndexLimits::default(),
        &CancellationToken::new(),
    )
    .completed()
    .unwrap();

    assert_eq!(report.indexed_files, 2);
    assert_eq!(report.skipped.duplicate_path, 0);
    assert_eq!(
        index.exact_content_for_relative_path("A/note.md"),
        Some("upper")
    );
    assert_eq!(
        index.exact_content_for_relative_path("a/note.md"),
        Some("lower")
    );
}

#[test]
fn enforces_file_count_per_file_and_aggregate_limits_with_skip_counts() {
    let limits = IndexLimits {
        max_files: 3,
        max_file_bytes: 8,
        max_aggregate_bytes: 10,
        ..IndexLimits::default()
    };
    let outcome = build_index(
        vec![
            document("a.md", "123456"),
            document("b.md", "123456789"),
            document("c.md", "123456"),
            document("d.txt", "ok"),
            document("e.md", "ok"),
        ],
        limits,
        &CancellationToken::new(),
    );
    let (_, report) = outcome.completed().unwrap();

    assert_eq!(report.indexed_files, 1);
    assert_eq!(report.indexed_bytes, 6);
    assert_eq!(report.skipped.oversized, 1);
    assert_eq!(report.skipped.aggregate_limit, 1);
    assert_eq!(report.skipped.file_count_limit, 1);
    assert_eq!(report.skipped.unsupported, 1);
}

#[test]
fn indexes_the_same_markdown_extensions_as_the_workspace_file_policy() {
    let (index, report) = build_index(
        vec![
            document("notes/readme.mdx", "mdx"),
            document("notes/readme.mkd", "mkd"),
            document("notes/legacy.mkdn", "legacy"),
        ],
        IndexLimits::default(),
        &CancellationToken::new(),
    )
    .completed()
    .unwrap();

    assert_eq!(report.indexed_files, 2);
    assert_eq!(
        query_index(
            &index,
            IndexQuery::full_text("mdx"),
            &CancellationToken::new()
        )
        .results[0]
            .relative_path,
        "notes/readme.mdx",
    );
    assert!(query_index(
        &index,
        IndexQuery::full_text("legacy"),
        &CancellationToken::new(),
    )
    .results
    .is_empty());
}

#[test]
fn filename_and_full_text_queries_have_stable_normalized_order_and_bounded_snippets() {
    let limits = IndexLimits {
        max_results: 2,
        max_snippet_chars: 12,
        ..IndexLimits::default()
    };
    let (index, _) = build_index(
        vec![
            document("notes/Zebra.md", "prefix searchable suffix"),
            document("notes/searchable-guide.md", "other"),
            document("Searchable.md", "last"),
        ],
        limits,
        &CancellationToken::new(),
    )
    .completed()
    .unwrap();

    let filenames = query_index(
        &index,
        IndexQuery::filename("searchable"),
        &CancellationToken::new(),
    );
    assert_eq!(
        filenames
            .results
            .iter()
            .map(|result| result.relative_path.as_str())
            .collect::<Vec<_>>(),
        vec!["Searchable.md", "notes/searchable-guide.md"]
    );

    let content = query_index(
        &index,
        IndexQuery::full_text("searchable"),
        &CancellationToken::new(),
    );
    assert_eq!(content.results[0].relative_path, "notes/Zebra.md");
    assert!(content.results[0].snippet.as_ref().unwrap().chars().count() <= 12);
}

#[test]
fn full_text_query_supports_unicode_cjk_and_full_case_folding() {
    let (index, _) = build_index(
        vec![document("unicode.md", "Rust Straße; 中文搜索; ος σ")],
        IndexLimits::default(),
        &CancellationToken::new(),
    )
    .completed()
    .unwrap();

    let cjk = query_index(
        &index,
        IndexQuery::full_text("中文"),
        &CancellationToken::new(),
    );
    let latin = query_index(
        &index,
        IndexQuery::full_text("STRASSE"),
        &CancellationToken::new(),
    );
    let sigma = query_index(
        &index,
        IndexQuery::full_text("οσ"),
        &CancellationToken::new(),
    );
    assert_eq!(cjk.results.len(), 1);
    assert_eq!(latin.results.len(), 1);
    assert_eq!(sigma.results.len(), 1);
}

#[test]
fn full_text_results_report_the_original_utf8_match_location() {
    let content = "前缀\r\nStraße\nCafe\u{301} needle";
    let (index, _) = build_index(
        vec![document("unicode.md", content)],
        IndexLimits::default(),
        &CancellationToken::new(),
    )
    .completed()
    .unwrap();

    let response = query_index(
        &index,
        IndexQuery::full_text("ss"),
        &CancellationToken::new(),
    );

    assert_eq!(response.results.len(), 1);
    assert_eq!(
        response.results[0].location,
        Some(QueryLocation {
            line: 2,
            utf8_byte_offset: "前缀\r\nStra".len(),
        }),
    );
}
