//! Windows NT path-identity and handle helpers.
#[cfg(windows)]
use std::{

    ffi::{c_void, OsStr, OsString},
    fs::File,
    io::{self, Write},
    mem::size_of,
    os::windows::{
        ffi::{OsStrExt, OsStringExt},
        io::{AsRawHandle, FromRawHandle},
    },
    path::{Path, PathBuf},
    ptr::{null, null_mut},
};

#[cfg(windows)]
use windows_sys::Wdk::{
    Foundation::OBJECT_ATTRIBUTES,
    Storage::FileSystem::{
        FileRenameInformation, NtCreateFile, NtSetInformationFile, FILE_CREATE,
        FILE_NON_DIRECTORY_FILE, FILE_OPEN, FILE_OPEN_REPARSE_POINT, FILE_RENAME_INFORMATION,
        FILE_RENAME_INFORMATION_0, FILE_SYNCHRONOUS_IO_NONALERT,
    },
};
#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::{
        RtlNtStatusToDosError, HANDLE, INVALID_HANDLE_VALUE, OBJ_CASE_INSENSITIVE, TRUE,
        UNICODE_STRING,
    },
    Globalization::{CompareStringOrdinal, CSTR_EQUAL},
    Storage::FileSystem::{
        CreateFileW, FileAttributeTagInfo, GetFileInformationByHandleEx,
        GetFinalPathNameByHandleW, DELETE, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL,
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_READ_DATA, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TRAVERSE, FILE_WRITE_DATA, OPEN_EXISTING,
        SYNCHRONIZE,
    },
    System::IO::IO_STATUS_BLOCK,
};

pub(crate) const DIRECTORY_SHARE_MODE: u32 =
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
pub(crate) const VERIFIED_PARENT_ACCESS: u32 = FILE_READ_ATTRIBUTES | FILE_TRAVERSE;
pub(crate) const REGULAR_FILE_OPEN_OPTIONS: u32 =
    FILE_OPEN_REPARSE_POINT | FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT;
pub(crate) const ENTRY_OPEN_OPTIONS: u32 = FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT;

pub(crate) fn wide_nul(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}

pub(crate) fn handle(file: &File) -> HANDLE {
    file.as_raw_handle() as HANDLE
}

pub(crate) fn invalid_input(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

pub(crate) fn permission_denied(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, message)
}

pub(crate) fn path_identity(path: &Path) -> Vec<u16> {
    path.as_os_str()
        .encode_wide()
        .map(|unit| {
            if unit == b'/' as u16 {
                b'\\' as u16
            } else {
                unit
            }
        })
        .collect()
}

pub(crate) fn paths_match(left: &Path, right: &Path) -> io::Result<bool> {
    let left = path_identity(left);
    let right = path_identity(right);
    let left_len = i32::try_from(left.len())
        .map_err(|_| invalid_input("opened path is too long to compare"))?;
    let right_len = i32::try_from(right.len())
        .map_err(|_| invalid_input("authorized path is too long to compare"))?;
    let comparison = unsafe {
        CompareStringOrdinal(left.as_ptr(), left_len, right.as_ptr(), right_len, TRUE)
    };
    if comparison == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(comparison == CSTR_EQUAL)
    }
}

pub(crate) fn opened_path(file: &File) -> io::Result<PathBuf> {
    let required = unsafe { GetFinalPathNameByHandleW(handle(file), null_mut(), 0, 0) };
    if required == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut buffer = vec![0_u16; required as usize + 1];
    let written = unsafe {
        GetFinalPathNameByHandleW(handle(file), buffer.as_mut_ptr(), buffer.len() as u32, 0)
    };
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

pub(crate) fn attribute_tag(file: &File) -> io::Result<FILE_ATTRIBUTE_TAG_INFO> {
    let mut info = FILE_ATTRIBUTE_TAG_INFO::default();
    let succeeded = unsafe {
        GetFileInformationByHandleEx(
            handle(file),
            FileAttributeTagInfo,
            (&mut info as *mut FILE_ATTRIBUTE_TAG_INFO).cast(),
            size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
    };
    if succeeded == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(info)
    }
}

pub(crate) fn open_directory(path: &Path) -> io::Result<File> {
    let path = wide_nul(path.as_os_str());
    let raw = unsafe {
        CreateFileW(
            path.as_ptr(),
            VERIFIED_PARENT_ACCESS,
            DIRECTORY_SHARE_MODE,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    if raw == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let directory = unsafe { File::from_raw_handle(raw as _) };
    let attributes = attribute_tag(&directory)?.FileAttributes;
    if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(permission_denied("parent directory is a reparse point"));
    }
    if attributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
        return Err(invalid_input("parent path is not a directory"));
    }
    Ok(directory)
}

pub(crate) fn open_verified_parent(parent: &Path) -> io::Result<File> {
    let directory = open_directory(parent)?;
    if !paths_match(&opened_path(&directory)?, parent)? {
        return Err(permission_denied(
            "parent directory changed after authorization",
        ));
    }
    Ok(directory)
}

pub(crate) fn file_name(name: &str) -> io::Result<Vec<u16>> {
    if name.is_empty() || name.contains(['\\', '/']) {
        return Err(invalid_input("resource file name is invalid"));
    }
    relative_name(Path::new(name))
}

pub(crate) fn relative_name(path: &Path) -> io::Result<Vec<u16>> {
    let name = path
        .file_name()
        .ok_or_else(|| invalid_input("path has no file name"))?;
    let name: Vec<u16> = name.encode_wide().collect();
    let byte_length = name
        .len()
        .checked_mul(size_of::<u16>())
        .ok_or_else(|| invalid_input("file name is too long"))?;
    if name.is_empty() || byte_length > u16::MAX as usize {
        return Err(invalid_input("file name is too long"));
    }
    Ok(name)
}

pub(crate) fn nt_error(status: i32) -> io::Error {
    let code = unsafe { RtlNtStatusToDosError(status) };
    io::Error::from_raw_os_error(code as i32)
}

