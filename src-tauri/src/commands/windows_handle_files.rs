//! Windows no-follow file operations built on NT handles.
use std::{
    ffi::c_void,
    fs::File,
    io,
    io::Write,
    mem::size_of,
    path::Path,
    ptr::{null, null_mut},
};
#[cfg(windows)]
use std::{
    os::windows::ffi::OsStrExt,
    os::windows::io::FromRawHandle,
};

#[cfg(windows)]
use windows_sys::Wdk::Foundation::OBJECT_ATTRIBUTES;
#[cfg(windows)]
use windows_sys::Wdk::Storage::FileSystem::{
    FileRenameInformation, NtCreateFile, NtSetInformationFile, FILE_CREATE,
    FILE_NON_DIRECTORY_FILE, FILE_OPEN, FILE_OPEN_REPARSE_POINT, FILE_RENAME_INFORMATION,
    FILE_RENAME_INFORMATION_0, FILE_SYNCHRONOUS_IO_NONALERT,
};
#[cfg(windows)]
use windows_sys::Win32::Foundation::{
    HANDLE, INVALID_HANDLE_VALUE, OBJ_CASE_INSENSITIVE, UNICODE_STRING,
};
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{
    DELETE, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT,
    FILE_READ_ATTRIBUTES, FILE_READ_DATA, FILE_SHARE_DELETE, FILE_TRAVERSE, FILE_WRITE_DATA,
    SYNCHRONIZE,
};
#[cfg(windows)]
use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;

pub(crate) mod nt;
use self::nt::*;

pub(crate) fn nt_open_relative(
    directory: &File,
    name: &[u16],
    desired_access: u32,
    disposition: u32,
    open_options: u32,
) -> io::Result<File> {
    let unicode_name = UNICODE_STRING {
        Length: (name.len() * size_of::<u16>()) as u16,
        MaximumLength: (name.len() * size_of::<u16>()) as u16,
        Buffer: name.as_ptr() as *mut u16,
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: handle(directory),
        ObjectName: &unicode_name,
        Attributes: OBJ_CASE_INSENSITIVE,
        SecurityDescriptor: null(),
        SecurityQualityOfService: null(),
    };
    let mut io_status = IO_STATUS_BLOCK::default();
    let mut raw: HANDLE = null_mut();
    let status = unsafe {
        NtCreateFile(
            &mut raw,
            desired_access,
            &attributes,
            &mut io_status,
            null(),
            FILE_ATTRIBUTE_NORMAL,
            DIRECTORY_SHARE_MODE,
            disposition,
            open_options,
            null(),
            0,
        )
    };
    if status < 0 {
        return Err(nt_error(status));
    }
    if raw.is_null() || raw == INVALID_HANDLE_VALUE {
        return Err(io::Error::new(
            io::ErrorKind::Other,
            "NtCreateFile returned an invalid handle",
        ));
    }
    Ok(unsafe { File::from_raw_handle(raw as _) })
}

fn validate_regular_child(file: &File) -> io::Result<()> {
    let attributes = attribute_tag(file)?.FileAttributes;
    if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(invalid_input("file is a reparse point"));
    }
    if attributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
        return Err(invalid_input("path is a directory"));
    }
    Ok(())
}

fn validate_directory_child(file: &File) -> io::Result<()> {
    let attributes = attribute_tag(file)?.FileAttributes;
    if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(invalid_input("directory is a reparse point"));
    }
    if attributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
        return Err(invalid_input("path is not a directory"));
    }
    Ok(())
}

fn validate_rename_entry(file: &File) -> io::Result<()> {
    if attribute_tag(file)?.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(invalid_input("rename entry is a reparse point"));
    }
    Ok(())
}

pub(crate) fn write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| invalid_input("path has no parent"))?;
    let name = relative_name(path)?;
    let directory = open_verified_parent(parent)?;
    let access = FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
    let (mut file, created) = match nt_open_relative(
        &directory,
        &name,
        access,
        FILE_OPEN,
        REGULAR_FILE_OPEN_OPTIONS,
    ) {
        Ok(file) => (file, false),
        Err(error) if error.kind() == io::ErrorKind::NotFound => (
            nt_open_relative(
                &directory,
                &name,
                access,
                FILE_CREATE,
                REGULAR_FILE_OPEN_OPTIONS,
            )?,
            true,
        ),
        Err(error) => return Err(error),
    };
    validate_regular_child(&file)?;
    if !created {
        file.set_len(0)?;
    }
    file.write_all(bytes)
}

pub(crate) fn open_read(path: &Path) -> io::Result<File> {
    let parent = path
        .parent()
        .ok_or_else(|| invalid_input("path has no parent"))?;
    let name = relative_name(path)?;
    let directory = open_verified_parent(parent)?;
    let file = nt_open_relative(
        &directory,
        &name,
        FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        FILE_OPEN,
        REGULAR_FILE_OPEN_OPTIONS,
    )?;
    validate_regular_child(&file)?;
    Ok(file)
}

pub(crate) fn open_read_beneath(root: &File, relative: &Path) -> io::Result<File> {
    let mut components = relative.components().peekable();
    let mut directory = root.try_clone()?;
    while let Some(component) = components.next() {
        let std::path::Component::Normal(name) = component else {
            return Err(invalid_input("workspace-relative path is invalid"));
        };
        let name = name.encode_wide().collect::<Vec<_>>();
        let byte_length = name
            .len()
            .checked_mul(size_of::<u16>())
            .ok_or_else(|| invalid_input("path component is too long"))?;
        if name.is_empty() || byte_length > u16::MAX as usize {
            return Err(invalid_input("path component is too long"));
        }
        let is_file = components.peek().is_none();
        let opened = nt_open_relative(
            &directory,
            &name,
            if is_file {
                FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE
            } else {
                VERIFIED_PARENT_ACCESS | SYNCHRONIZE
            },
            FILE_OPEN,
            if is_file {
                REGULAR_FILE_OPEN_OPTIONS
            } else {
                ENTRY_OPEN_OPTIONS
            },
        )?;
        if is_file {
            validate_regular_child(&opened)?;
            return Ok(opened);
        }
        validate_directory_child(&opened)?;
        directory = opened;
    }
    Err(invalid_input("workspace-relative path is empty"))
}

fn destination_exists(directory: &File, name: &[u16]) -> io::Result<bool> {
    match nt_open_relative(
        directory,
        name,
        FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        FILE_OPEN,
        ENTRY_OPEN_OPTIONS,
    ) {
        Ok(file) => {
            validate_rename_entry(&file)?;
            Ok(true)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn rename_information_buffer_size(name_bytes: usize) -> usize {
    size_of::<FILE_RENAME_INFORMATION>() + name_bytes
}

fn rename_no_replace_with_precommit(
    from: &Path,
    to: &Path,
    precommit: impl FnOnce() -> io::Result<()>,
) -> io::Result<()> {
    let source_parent = from
        .parent()
        .ok_or_else(|| invalid_input("source path has no parent"))?;
    let destination_parent = to
        .parent()
        .ok_or_else(|| invalid_input("destination path has no parent"))?;
    let source_name = relative_name(from)?;
    let destination_name = relative_name(to)?;
    let source_directory = open_verified_parent(source_parent)?;
    let destination_directory = open_verified_parent(destination_parent)?;
    if destination_exists(&destination_directory, &destination_name)? {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "rename destination already exists",
        ));
    }
    let source = nt_open_relative(
        &source_directory,
        &source_name,
        DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        FILE_OPEN,
        ENTRY_OPEN_OPTIONS,
    )?;
    validate_rename_entry(&source)?;
    precommit()?;

    let name_bytes = destination_name.len() * size_of::<u16>();
    let buffer_bytes = rename_information_buffer_size(name_bytes);
    let words = buffer_bytes.div_ceil(size_of::<usize>());
    let mut storage = vec![0_usize; words];
    let rename = storage.as_mut_ptr().cast::<FILE_RENAME_INFORMATION>();
    unsafe {
        (*rename).Anonymous = FILE_RENAME_INFORMATION_0::default();
        (*rename).RootDirectory = handle(&destination_directory);
        (*rename).FileNameLength = name_bytes as u32;
        std::ptr::copy_nonoverlapping(
            destination_name.as_ptr(),
            std::ptr::addr_of_mut!((*rename).FileName).cast::<u16>(),
            destination_name.len(),
        );
    }
    let mut io_status = IO_STATUS_BLOCK::default();
    // The kernel32 wrapper canonicalizes relative names before forwarding them;
    // use the native primitive so the verified directory handle remains the root.
    let status = unsafe {
        NtSetInformationFile(
            handle(&source),
            &mut io_status,
            rename.cast::<c_void>(),
            buffer_bytes as u32,
            FileRenameInformation,
        )
    };
    if status < 0 {
        Err(nt_error(status))
    } else {
        Ok(())
    }
}

pub(crate) fn rename_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    rename_no_replace_with_precommit(from, to, || Ok(()))
}

#[cfg(test)]
pub(crate) fn rename_no_replace_with_hook(
    from: &Path,
    to: &Path,
    precommit: impl FnOnce() -> io::Result<()>,
) -> io::Result<()> {
    rename_no_replace_with_precommit(from, to, precommit)
}

#[cfg(all(test, target_os = "windows"))]
mod tests;
