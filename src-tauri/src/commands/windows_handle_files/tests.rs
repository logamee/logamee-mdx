use super::*;

use super::*;

#[test]
fn rename_buffer_includes_the_full_structure_and_file_name() {
    let name_bytes = size_of::<u16>();

    assert_eq!(
        rename_information_buffer_size(name_bytes),
        size_of::<FILE_RENAME_INFORMATION>() + name_bytes
    );
    assert!(
        rename_information_buffer_size(name_bytes)
            > std::mem::offset_of!(FILE_RENAME_INFORMATION, FileName)
                + name_bytes
                + size_of::<u16>()
    );
}

#[test]
fn verified_parent_handle_supports_relative_rename() {
    assert_ne!(VERIFIED_PARENT_ACCESS & FILE_TRAVERSE, 0);
    assert_ne!(DIRECTORY_SHARE_MODE & FILE_SHARE_DELETE, 0);
}
