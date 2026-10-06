//! Windows relative rename/delete operations.
use std::{ffi::c_void, path::Path};

use super::secure_fs_windows::*;
use super::*;

fn rename_relative(
    directory: &File,
    staged: &str,
    final_name: &str,
    replace: bool,
) -> io::Result<()> {
    let staged_name = file_name(staged)?;
    let destination_name = file_name(final_name)?;
    let source = nt_open_relative(
        directory,
        &staged_name,
        DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        FILE_OPEN,
        REGULAR_FILE_OPEN_OPTIONS,
    )?;
    validate_regular_file(&source)?;
    let name_bytes = destination_name.len() * size_of::<u16>();
    let buffer_bytes = size_of::<FILE_RENAME_INFORMATION>() + name_bytes;
    let mut storage = vec![0_usize; buffer_bytes.div_ceil(size_of::<usize>())];
    let rename = storage.as_mut_ptr().cast::<FILE_RENAME_INFORMATION>();
    unsafe {
        (*rename).Anonymous = FILE_RENAME_INFORMATION_0 {
            ReplaceIfExists: replace,
        };
        (*rename).RootDirectory = handle(directory);
        (*rename).FileNameLength = name_bytes as u32;
        std::ptr::copy_nonoverlapping(
            destination_name.as_ptr(),
            std::ptr::addr_of_mut!((*rename).FileName).cast::<u16>(),
            destination_name.len(),
        );
    }
    let mut io_status = IO_STATUS_BLOCK::default();
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

fn delete_relative(directory: &File, name: &str) -> io::Result<()> {
    let name = file_name(name)?;
    let file = nt_open_relative(
        directory,
        &name,
        DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        FILE_OPEN,
        REGULAR_FILE_OPEN_OPTIONS,
    )?;
    validate_regular_file(&file)?;
    let mut disposition = FILE_DISPOSITION_INFORMATION { DeleteFile: true };
    let mut io_status = IO_STATUS_BLOCK::default();
    let status = unsafe {
        NtSetInformationFile(
            handle(&file),
            &mut io_status,
            (&mut disposition as *mut FILE_DISPOSITION_INFORMATION).cast::<c_void>(),
            size_of::<FILE_DISPOSITION_INFORMATION>() as u32,
            FileDispositionInformation,
        )
    };
    if status < 0 {
        Err(nt_error(status))
    } else {
        Ok(())
    }
}

pub(super) fn mkdirs_open_final(root: &File, relative: &Path) -> io::Result<File> {
    let mut current = root.try_clone()?;
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err(invalid_input("relative resource directory is invalid"));
        };
        let name = relative_name(Path::new(name))?;
        let next = nt_open_relative(
            &current,
            &name,
            FILE_READ_ATTRIBUTES | FILE_TRAVERSE | SYNCHRONIZE,
            FILE_OPEN_IF,
            DIRECTORY_OPEN_OPTIONS,
        )?;
        validate_directory(&next)?;
        current = next;
    }
    Ok(current)
}

pub(super) fn create_new_file_at(directory: &File, name: &str) -> io::Result<File> {
    let name = file_name(name)?;
    let file = nt_open_relative(
        directory,
        &name,
        FILE_READ_DATA | FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        FILE_CREATE,
        REGULAR_FILE_OPEN_OPTIONS,
    )?;
    validate_regular_file(&file)?;
    Ok(file)
}

pub(super) fn open_existing_file_at(directory: &File, name: &str) -> io::Result<File> {
    let name = file_name(name)?;
    let file = nt_open_relative(
        directory,
        &name,
        FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        FILE_OPEN,
        REGULAR_FILE_OPEN_OPTIONS,
    )?;
    validate_regular_file(&file)?;
    Ok(file)
}

pub(super) fn publish_no_replace(
    directory: &File,
    staged: &str,
    final_name: &str,
) -> io::Result<()> {
    rename_relative(directory, staged, final_name, false)
}

pub(super) fn publish_replace(
    directory: &File,
    staged: &str,
    final_name: &str,
) -> io::Result<()> {
    rename_relative(directory, staged, final_name, true)
}

pub(super) fn unlink_at(directory: &File, name: &str) {
    let _ = delete_relative(directory, name);
}

pub(super) fn sync_directory(_directory: &File) -> io::Result<()> {
    Ok(())
}
