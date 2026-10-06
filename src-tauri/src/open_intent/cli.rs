//! Command-line argument parsing for open intents.
use std::{
    ffi::{OsStr, OsString},
    path::{Component, Path, PathBuf},
};

use super::OpenIntentParseError;

pub(crate) fn parse_open_intent_args<I, S>(
    args: I,
    forwarded_cwd: &Path,
) -> Result<PathBuf, OpenIntentParseError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    if !forwarded_cwd.is_absolute() {
        return Err(OpenIntentParseError::InvalidWorkingDirectory);
    }
    let mut arguments = args.into_iter();
    let _program_name = arguments.next();
    let mut target: Option<OsString> = None;
    let mut literal_target = false;

    for argument in arguments {
        let argument = argument.as_ref();
        if !literal_target && argument == OsStr::new("--") {
            literal_target = true;
            continue;
        }
        if !literal_target && starts_with_dash(argument) {
            return Err(OpenIntentParseError::UnexpectedOption);
        }
        if target.replace(argument.to_os_string()).is_some() {
            return Err(OpenIntentParseError::MultipleTargets);
        }
    }

    let target = target.ok_or(OpenIntentParseError::MissingTarget)?;
    if target.is_empty() {
        return Err(OpenIntentParseError::EmptyTarget);
    }
    let target = PathBuf::from(target);
    let candidate = if target.is_absolute() {
        target
    } else {
        forwarded_cwd.join(target)
    };
    Ok(normalize_lexically(&candidate))
}

fn starts_with_dash(value: &OsStr) -> bool {
    value.to_string_lossy().starts_with('-')
}

pub(crate) fn normalize_lexically(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() && !normalized.has_root() {
                    normalized.push(component.as_os_str());
                }
            }
            Component::Normal(segment) => normalized.push(segment),
            Component::RootDir | Component::Prefix(_) => normalized.push(component.as_os_str()),
        }
    }
    normalized
}
