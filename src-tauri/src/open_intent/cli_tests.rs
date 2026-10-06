use std::path::Path;

use super::*;
use super::tests::{args, work_root};

#[test]
fn parser_discards_program_name_and_resolves_one_relative_target() {
    assert_eq!(
        parse_open_intent_args(args(&["mmd", "notes/../draft.md"]), &work_root()),
        Ok(work_root().join("draft.md"))
    );
}

#[test]
fn parser_requires_double_dash_for_dash_prefixed_filename() {
    assert_eq!(
        parse_open_intent_args(args(&["mmd", "-draft.md"]), &work_root()),
        Err(OpenIntentParseError::UnexpectedOption)
    );
    assert_eq!(
        parse_open_intent_args(args(&["mmd", "--", "-draft.md"]), &work_root()),
        Ok(work_root().join("-draft.md"))
    );
}

#[test]
fn opaque_ids_round_trip_only_through_the_strict_wire_format() {
    let id = OpenIntentId(42);
    assert_eq!(id.to_wire(), "open-intent-42");
    assert_eq!(OpenIntentId::from_wire("open-intent-42"), Some(id));
    assert_eq!(OpenIntentId::from_wire("42"), None);
    assert_eq!(OpenIntentId::from_wire("open-intent-0"), None);
}

#[test]
fn parser_rejects_missing_multiple_and_option_arguments() {
    assert_eq!(
        parse_open_intent_args(args(&["mmd"]), &work_root()),
        Err(OpenIntentParseError::MissingTarget)
    );
    assert_eq!(
        parse_open_intent_args(args(&["mmd", "a.md", "b.md"]), &work_root()),
        Err(OpenIntentParseError::MultipleTargets)
    );
    assert_eq!(
        parse_open_intent_args(args(&["mmd", "--help"]), &work_root()),
        Err(OpenIntentParseError::UnexpectedOption)
    );
    assert_eq!(
        parse_open_intent_args(args(&["mmd", "draft.md"]), Path::new("relative")),
        Err(OpenIntentParseError::InvalidWorkingDirectory)
    );
    assert_eq!(
        parse_open_intent_args(args(&["mmd", ""]), &work_root()),
        Err(OpenIntentParseError::EmptyTarget)
    );
}
