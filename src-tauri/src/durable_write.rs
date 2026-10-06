#[allow(unused_imports)]
use std::{ fs::{self, File },
    io::{self},
    path::{PathBuf},
    sync::{Arc, Mutex}};
use crate::private_fs::lowercase_hex;

use serde::{de::Error as _, Deserialize, Deserializer, Serialize, Serializer};
use sha2::{Digest, Sha256};

const STAGING_ATTEMPTS: usize = 32;
static DURABLE_WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileVersion {
    canonical_path: String,
    platform_identity: String,
    #[serde(serialize_with = "serialize_decimal")]
    length: u64,
    #[serde(serialize_with = "serialize_decimal")]
    modified_nanos: u128,
    sha256: String,
    #[serde(skip)]
    file_binding: Option<Arc<File>>,
}

impl PartialEq for FileVersion {
    fn eq(&self, other: &Self) -> bool {
        self.canonical_path == other.canonical_path
            && self.platform_identity == other.platform_identity
            && self.length == other.length
            && self.modified_nanos == other.modified_nanos
            && self.sha256 == other.sha256
    }
}

impl Eq for FileVersion {}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileVersionWire {
    canonical_path: String,
    platform_identity: String,
    length: String,
    modified_nanos: String,
    sha256: String,
}

impl<'de> Deserialize<'de> for FileVersion {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = FileVersionWire::deserialize(deserializer)?;
        if wire.canonical_path.is_empty() {
            return Err(D::Error::custom("canonicalPath must not be empty"));
        }
        if wire.platform_identity.is_empty() {
            return Err(D::Error::custom("platformIdentity must not be empty"));
        }
        if wire.sha256.len() != 64
            || !wire
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(D::Error::custom(
                "sha256 must contain exactly 64 lowercase hexadecimal characters",
            ));
        }
        Ok(Self {
            canonical_path: wire.canonical_path,
            platform_identity: wire.platform_identity,
            length: parse_decimal(&wire.length).map_err(D::Error::custom)?,
            modified_nanos: parse_decimal(&wire.modified_nanos).map_err(D::Error::custom)?,
            sha256: wire.sha256,
            file_binding: None,
        })
    }
}

fn serialize_decimal<T: ToString, S: Serializer>(
    value: &T,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&value.to_string())
}

fn parse_decimal<T>(value: &str) -> Result<T, &'static str>
where
    T: std::str::FromStr,
{
    if value.is_empty()
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err("decimal integers must use canonical unsigned digit strings");
    }
    value
        .parse()
        .map_err(|_| "decimal integer is outside the supported range")
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ExpectedFileState {
    Absent,
    Exact { version: FileVersion },
}

impl ExpectedFileState {
    fn version(&self) -> Option<&FileVersion> {
        match self {
            Self::Absent => None,
            Self::Exact { version } => Some(version),
        }
    }
}

#[derive(Debug)]
pub(crate) struct VersionedFileBytes {
    pub(crate) bytes: Vec<u8>,
    pub(crate) version: FileVersion,
}

impl FileVersion {
    fn is_displaced_version_of(&self, expected: &Self) -> bool {
        self.platform_identity == expected.platform_identity
            && self.length == expected.length
            && self.modified_nanos == expected.modified_nanos
            && self.sha256 == expected.sha256
    }

    pub(crate) fn length(&self) -> u64 {
        self.length
    }

    pub(crate) fn platform_identity(&self) -> &str {
        &self.platform_identity
    }

    pub(crate) fn retained_file_binding(&self) -> Option<Arc<File>> {
        self.file_binding.clone()
    }

    pub(crate) fn opaque_token(&self) -> String {
        let mut digest = Sha256::new();
        let length = self.length.to_string();
        let modified_nanos = self.modified_nanos.to_string();
        for field in [
            self.canonical_path.as_bytes(),
            self.platform_identity.as_bytes(),
            length.as_bytes(),
            modified_nanos.as_bytes(),
            self.sha256.as_bytes(),
        ] {
            digest.update((field.len() as u64).to_be_bytes());
            digest.update(field);
        }
        lowercase_hex(&digest.finalize())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum DurableDeleteOutcome {
    ConfirmedDeleted,
    ConfirmedNotDeleted {
        current_version: Option<FileVersion>,
        recovery_paths: Vec<PathBuf>,
    },
    Conflict {
        current_version: Option<FileVersion>,
        recovery_paths: Vec<PathBuf>,
    },
    Indeterminate {
        recovery_paths: Vec<PathBuf>,
    },
}


pub(crate) use classify::*;
pub(crate) use install::*;
pub(crate) use quarantine::*;
pub(crate) use observe::*;
pub(crate) use read::*;
pub(crate) use recovery::*;
pub(crate) use remove::*;
pub(crate) use write::*;
mod classify;
mod install;
mod observe;
mod quarantine;
mod read;
mod recovery;
mod remove;
mod write;
mod write_replace;
mod write_stages;
#[cfg(test)]
mod test_prelude;
#[cfg(test)]
mod group0_tests;
#[cfg(test)]
mod group1_tests;
#[cfg(test)]
mod group2_tests;
#[cfg(test)]
mod group3_tests;
#[cfg(test)]
mod group4_tests;
