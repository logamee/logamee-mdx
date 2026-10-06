//! Secure filesystem access on Windows.
use super::*;
pub(crate) use crate::commands::windows_handle_files::nt::{
    file_name, handle, invalid_input, nt_error, permission_denied, relative_name,
};
pub(crate) use crate::commands::windows_handle_files::nt_open_relative;

use super::*;
use std::{
    ffi::c_void,
    mem::size_of,
    os::windows::{ // platform-audit: allow (platform-gated secure-fs transport)
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle},
    },
    ptr::{null, null_mut},
};

pub(crate) use windows_sys::{ // platform-audit: allow (platform-gated secure-fs transport)
    Wdk::{
        Foundation::OBJECT_ATTRIBUTES,
        Storage::FileSystem::{
            FileDispositionInformation, FileRenameInformation, NtCreateFile,
            NtSetInformationFile, FILE_CREATE, FILE_DIRECTORY_FILE,
            FILE_DISPOSITION_INFORMATION, FILE_NON_DIRECTORY_FILE, FILE_OPEN, FILE_OPEN_IF,
            FILE_OPEN_REPARSE_POINT, FILE_RENAME_INFORMATION, FILE_RENAME_INFORMATION_0,
            FILE_SYNCHRONOUS_IO_NONALERT,
        },
    },
    Win32::{
        Foundation::{
            RtlNtStatusToDosError, HANDLE, INVALID_HANDLE_VALUE, OBJ_CASE_INSENSITIVE,
            UNICODE_STRING,
        },
        Storage::FileSystem::{
            FileAttributeTagInfo, GetFileInformationByHandleEx, DELETE,
            FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT,
            FILE_ATTRIBUTE_TAG_INFO, FILE_READ_ATTRIBUTES, FILE_READ_DATA, FILE_SHARE_DELETE,
            FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TRAVERSE, FILE_WRITE_DATA, SYNCHRONIZE,
        },
        System::IO::IO_STATUS_BLOCK,
    },
};

pub(crate) const DIRECTORY_SHARE_MODE: u32 = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
pub(crate) const DIRECTORY_OPEN_OPTIONS: u32 =
    FILE_OPEN_REPARSE_POINT | FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT;
pub(crate) const REGULAR_FILE_OPEN_OPTIONS: u32 =
    FILE_OPEN_REPARSE_POINT | FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT;

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

pub(crate) fn validate_directory(file: &File) -> io::Result<()> {
    let attributes = attribute_tag(file)?.FileAttributes;
    if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(permission_denied("resource directory is a reparse point"));
    }
    if attributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
        return Err(invalid_input("resource path component is not a directory"));
    }
    Ok(())
}

pub(crate) fn validate_regular_file(file: &File) -> io::Result<()> {
    let attributes = attribute_tag(file)?.FileAttributes;
    if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(permission_denied("resource is a reparse point"));
    }
    if attributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
        return Err(invalid_input("resource is not a regular file"));
    }
    Ok(())
}
