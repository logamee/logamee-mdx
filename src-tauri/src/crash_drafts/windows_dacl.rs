//! Windows DACL construction and verification.
use std::{fs::OpenOptions, io, path::Path};
#[cfg(windows)]
pub(crate) fn current_process_token_information(
    information_class: windows_sys::Win32::Security::TOKEN_INFORMATION_CLASS,
) -> io::Result<Vec<usize>> {
    use std::{mem, ptr};
    use windows_sys::Win32::{Foundation::HANDLE, Security::GetTokenInformation};
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
pub(crate) fn current_process_user_sid_string() -> io::Result<String> {
    use std::ptr;
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::{Authorization::ConvertSidToStringSidW, TokenUser, TOKEN_USER},
    };
    let token = current_process_token_information(TokenUser)?;
    let token_user = unsafe { &*token.as_ptr().cast::<TOKEN_USER>() };
    let mut string_sid = ptr::null_mut();
    if unsafe { ConvertSidToStringSidW(token_user.User.Sid, &mut string_sid) } == 0
        || string_sid.is_null()
    {
        return Err(io::Error::last_os_error());
    }
    let result = (|| {
        let length = unsafe { (0..1024).position(|index| *string_sid.add(index) == 0) }
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "unterminated TokenUser SID")
            })?;
        String::from_utf16(unsafe { std::slice::from_raw_parts(string_sid, length) })
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid TokenUser SID"))
    })();
    unsafe {
        LocalFree(string_sid.cast());
    }
    result
}
#[cfg(windows)]
pub(crate) fn private_windows_sddl(base: &str, ace_flags: &str) -> io::Result<String> {
    let token_user = current_process_user_sid_string()?;
    Ok(format!("{base}(A;{ace_flags};FA;;;{token_user})"))
}

#[cfg(windows)]
pub(crate) fn apply_and_verify_private_windows_dacl(
    path: &Path,
    sddl: &str,
    expected_ace_flags: u8,
) -> io::Result<()> {
    use std::{mem, os::windows::ffi::OsStrExt, ptr};
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::{
            AclSizeInformation,
            Authorization::{
                ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
            },
            GetAclInformation, GetFileSecurityW, GetSecurityDescriptorControl,
            GetSecurityDescriptorDacl, SetFileSecurityW, ACL_SIZE_INFORMATION,
            DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
            SE_DACL_PROTECTED,
        },
        Storage::FileSystem::FILE_ALL_ACCESS,
    };

    let wide_path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let wide_sddl: Vec<u16> = sddl.encode_utf16().chain(Some(0)).collect();
    let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
    let converted = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            wide_sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            ptr::null_mut(),
        )
    };
    if converted == 0 || descriptor.is_null() {
        return Err(io::Error::last_os_error());
    }

    let result = (|| {
        let applied = unsafe {
            SetFileSecurityW(
                wide_path.as_ptr(),
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                descriptor,
            )
        };
        if applied == 0 {
            return Err(io::Error::last_os_error());
        }

        let mut needed = 0u32;
        unsafe {
            GetFileSecurityW(
                wide_path.as_ptr(),
                DACL_SECURITY_INFORMATION,
                ptr::null_mut(),
                0,
                &mut needed,
            );
        }
        if needed == 0 {
            return Err(io::Error::last_os_error());
        }
        let word_size = mem::size_of::<usize>();
        let mut security = vec![0usize; (needed as usize).div_ceil(word_size)];
        let read = unsafe {
            GetFileSecurityW(
                wide_path.as_ptr(),
                DACL_SECURITY_INFORMATION,
                security.as_mut_ptr().cast(),
                needed,
                &mut needed,
            )
        };
        if read == 0 {
            return Err(io::Error::last_os_error());
        }
        let observed = security.as_mut_ptr().cast();
        let mut control = 0u16;
        let mut revision = 0u32;
        if unsafe { GetSecurityDescriptorControl(observed, &mut control, &mut revision) } == 0
            || control & SE_DACL_PROTECTED == 0
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "private DACL protection could not be verified",
            ));
        }
        let mut present = 0;
        let mut defaulted = 0;
        let mut dacl = ptr::null_mut();
        if unsafe { GetSecurityDescriptorDacl(observed, &mut present, &mut dacl, &mut defaulted) }
            == 0
            || present == 0
            || dacl.is_null()
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "private DACL presence could not be verified",
            ));
        }
        let mut acl_info = ACL_SIZE_INFORMATION::default();
        if unsafe {
            GetAclInformation(
                dacl,
                (&mut acl_info as *mut ACL_SIZE_INFORMATION).cast(),
                mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            )
        } == 0
            || acl_info.AceCount != 4
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "private DACL entries could not be verified",
            ));
        }
        verify_private_windows_aces(dacl, expected_ace_flags, FILE_ALL_ACCESS)?;
        Ok(())
    })();
    unsafe {
        LocalFree(descriptor);
    }
    result
}

#[cfg(windows)]
pub(crate) fn verify_private_windows_aces(
    dacl: *mut windows_sys::Win32::Security::ACL,
    expected_ace_flags: u8,
    expected_mask: u32,
) -> io::Result<()> {
    use std::{mem, ptr};
    use windows_sys::Win32::Security::{
        CreateWellKnownSid, EqualSid, GetAce, TokenUser, WinBuiltinAdministratorsSid,
        WinCreatorOwnerRightsSid, WinLocalSystemSid, ACCESS_ALLOWED_ACE, SECURITY_MAX_SID_SIZE,
        TOKEN_USER,
    };

    let mut well_known_sids = Vec::new();
    for sid_type in [
        WinCreatorOwnerRightsSid,
        WinLocalSystemSid,
        WinBuiltinAdministratorsSid,
    ] {
        let mut sid = vec![0u8; SECURITY_MAX_SID_SIZE as usize];
        let mut size = SECURITY_MAX_SID_SIZE;
        if unsafe {
            CreateWellKnownSid(
                sid_type,
                ptr::null_mut(),
                sid.as_mut_ptr().cast(),
                &mut size,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        sid.truncate(size as usize);
        well_known_sids.push(sid);
    }

    let token = current_process_token_information(TokenUser)?;
    let token_user = unsafe { &*token.as_ptr().cast::<TOKEN_USER>() };
    let mut expected_sids: Vec<_> = well_known_sids
        .iter()
        .map(|sid| sid.as_ptr().cast_mut().cast())
        .collect();
    expected_sids.push(token_user.User.Sid);

    let mut matched = vec![false; expected_sids.len()];
    for index in 0..expected_sids.len() as u32 {
        let mut raw_ace = ptr::null_mut();
        if unsafe { GetAce(dacl, index, &mut raw_ace) } == 0 || raw_ace.is_null() {
            return Err(io::Error::last_os_error());
        }
        let ace = unsafe { &*raw_ace.cast::<ACCESS_ALLOWED_ACE>() };
        // ACCESS_ALLOWED_ACE_TYPE is zero. The literal avoids adding
        // Win32_System_SystemServices solely for this discriminator.
        if ace.Header.AceType != 0
            || ace.Header.AceFlags != expected_ace_flags
            || ace.Mask != expected_mask
            || usize::from(ace.Header.AceSize) < mem::size_of::<ACCESS_ALLOWED_ACE>()
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "private DACL ACE policy could not be verified",
            ));
        }
        let observed_sid = (&ace.SidStart as *const u32).cast_mut().cast();
        let Some(expected_index) =
            expected_sids
                .iter()
                .enumerate()
                .position(|(expected_index, expected)| {
                    !matched[expected_index] && unsafe { EqualSid(observed_sid, *expected) != 0 }
                })
        else {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "private DACL trustee could not be verified",
            ));
        };
        matched[expected_index] = true;
    }
    if !matched.into_iter().all(|value| value) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "private DACL is missing a required trustee",
        ));
    }
    Ok(())
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn make_directory_private(_path: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "private crash-draft ACL support is unavailable",
    ))
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn make_file_private(_path: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "private crash-draft ACL support is unavailable",
    ))
}
