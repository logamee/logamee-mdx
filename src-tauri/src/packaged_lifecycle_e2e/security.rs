//! Private-container primitives extracted from the packaged lifecycle setup.
use super::*;

#[cfg(unix)]
pub(super) fn create_private_workspace(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;

    let mut builder = fs::DirBuilder::new();
    builder.mode(0o700).create(path)
}

#[cfg(windows)]
pub(super) fn create_private_workspace(path: &Path) -> io::Result<()> {
    fs::create_dir(path)?;
    crate::crash_drafts::make_directory_private(path)?;
    verify_windows_directory_owner(path)?;
    Ok(())
}

#[cfg(not(any(unix, windows)))]
pub(super) fn create_private_workspace(_path: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "private directory creation is unavailable",
    ))
}

#[cfg(windows)]
pub(super) fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
pub(super) fn is_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

#[cfg(unix)]
pub(super) fn existing_container_is_private(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;

    metadata.uid() == unsafe { libc::geteuid() } && metadata.mode() & 0o077 == 0
}

#[cfg(windows)]
pub(super) fn secure_existing_container(path: &Path) -> io::Result<()> {
    verify_windows_directory_owner(path)?;
    crate::crash_drafts::make_directory_private(path)?;
    verify_windows_directory_owner(path)
}

#[cfg(windows)]
fn current_process_token_information(
    information_class: windows_sys::Win32::Security::TOKEN_INFORMATION_CLASS,
) -> io::Result<Vec<usize>> {
    use std::{mem, ptr};
    use windows_sys::Win32::{Foundation::HANDLE, Security::GetTokenInformation};

    // The process-token pseudo handle is supported by Windows 8 and later.
    const CURRENT_PROCESS_TOKEN: HANDLE = (-4_isize) as HANDLE;
    let mut token_size = 0u32;
    unsafe {
        GetTokenInformation(
            CURRENT_PROCESS_TOKEN,
            information_class,
            ptr::null_mut(),
            0,
            &mut token_size,
        );
    }
    if token_size == 0 {
        return Err(io::Error::last_os_error());
    }
    let word_size = mem::size_of::<usize>();
    let mut token = vec![0usize; (token_size as usize).div_ceil(word_size)];
    if unsafe {
        GetTokenInformation(
            CURRENT_PROCESS_TOKEN,
            information_class,
            token.as_mut_ptr().cast(),
            token_size,
            &mut token_size,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(token)
}

#[cfg(windows)]
fn verify_windows_directory_owner(path: &Path) -> io::Result<()> {
    use std::{mem, os::windows::ffi::OsStrExt, ptr};
    use windows_sys::Win32::Security::{
        EqualSid, GetFileSecurityW, GetSecurityDescriptorOwner, TokenOwner, TokenUser,
        OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, TOKEN_OWNER, TOKEN_USER,
    };

    let wide_path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut security_size = 0u32;
    unsafe {
        GetFileSecurityW(
            wide_path.as_ptr(),
            OWNER_SECURITY_INFORMATION,
            ptr::null_mut(),
            0,
            &mut security_size,
        );
    }
    if security_size == 0 {
        return Err(io::Error::last_os_error());
    }
    let word_size = mem::size_of::<usize>();
    let mut security = vec![0usize; (security_size as usize).div_ceil(word_size)];
    if unsafe {
        GetFileSecurityW(
            wide_path.as_ptr(),
            OWNER_SECURITY_INFORMATION,
            security.as_mut_ptr().cast(),
            security_size,
            &mut security_size,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let descriptor: PSECURITY_DESCRIPTOR = security.as_mut_ptr().cast();
    let mut owner = ptr::null_mut();
    let mut owner_defaulted = 0;
    if unsafe { GetSecurityDescriptorOwner(descriptor, &mut owner, &mut owner_defaulted) } == 0
        || owner.is_null()
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "private directory owner could not be verified",
        ));
    }

    let token_user = current_process_token_information(TokenUser)?;
    let token_user = unsafe { &*token_user.as_ptr().cast::<TOKEN_USER>() };
    let token_owner = current_process_token_information(TokenOwner)?;
    let token_owner = unsafe { &*token_owner.as_ptr().cast::<TOKEN_OWNER>() };
    if unsafe { EqualSid(owner, token_user.User.Sid) } == 0
        && unsafe { EqualSid(owner, token_owner.Owner) } == 0
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "private directory owner is outside the current process token",
        ));
    }
    Ok(())
}

#[cfg(not(any(unix, windows)))]
pub(super) fn secure_existing_container(_path: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "private directory verification is unavailable",
    ))
}
