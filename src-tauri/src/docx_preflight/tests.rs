use super::preflight_docx_zip;

const REAL_COMPRESSED_DOCX: &[u8] =
    include_bytes!("../../../test-fixtures/p2/docx/single-paragraph.docx");

fn append_u16(bytes: &mut Vec<u8>, value: u16) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

fn append_u32(bytes: &mut Vec<u8>, value: u32) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

fn append_u64(bytes: &mut Vec<u8>, value: u64) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

fn one_entry_classic_zip() -> Vec<u8> {
    let mut bytes = Vec::new();
    append_u32(&mut bytes, 0x0403_4b50);
    append_u16(&mut bytes, 20);
    append_u16(&mut bytes, 0);
    append_u16(&mut bytes, 0);
    append_u16(&mut bytes, 0);
    append_u16(&mut bytes, 0);
    append_u32(&mut bytes, 0);
    append_u32(&mut bytes, 0);
    append_u32(&mut bytes, 0);
    append_u16(&mut bytes, 0);
    append_u16(&mut bytes, 0);

    append_u32(&mut bytes, 0x0201_4b50);
    append_u16(&mut bytes, 20);
    append_u16(&mut bytes, 20);
    append_u16(&mut bytes, 0);
    append_u16(&mut bytes, 0);
    append_u16(&mut bytes, 0);
    append_u16(&mut bytes, 0);
    append_u32(&mut bytes, 0);
    append_u32(&mut bytes, 0);
    append_u32(&mut bytes, 0);
    append_u16(&mut bytes, 0);
    append_u16(&mut bytes, 0);
    append_u16(&mut bytes, 0);
    append_u16(&mut bytes, 0);
    append_u16(&mut bytes, 0);
    append_u32(&mut bytes, 0);
    append_u32(&mut bytes, 0);

    append_u32(&mut bytes, 0x0605_4b50);
    append_u16(&mut bytes, 0);
    append_u16(&mut bytes, 0);
    append_u16(&mut bytes, 1);
    append_u16(&mut bytes, 1);
    append_u32(&mut bytes, 46);
    append_u32(&mut bytes, 30);
    append_u16(&mut bytes, 0);
    bytes
}

fn one_entry_zip64(shadow_central_directory: bool) -> Vec<u8> {
    let classic = one_entry_classic_zip();
    let mut bytes = classic[..76].to_vec();
    if shadow_central_directory {
        let mut shadow = classic[30..76].to_vec();
        shadow[24..28].copy_from_slice(&1u32.to_le_bytes());
        bytes.extend_from_slice(&shadow);
    }
    let zip64_eocd_offset = bytes.len() as u64;

    append_u32(&mut bytes, 0x0606_4b50);
    append_u64(&mut bytes, 44);
    append_u16(&mut bytes, 45);
    append_u16(&mut bytes, 45);
    append_u32(&mut bytes, 0);
    append_u32(&mut bytes, 0);
    append_u64(&mut bytes, 1);
    append_u64(&mut bytes, 1);
    append_u64(&mut bytes, 46);
    append_u64(&mut bytes, 30);

    append_u32(&mut bytes, 0x0706_4b50);
    append_u32(&mut bytes, 0);
    append_u64(&mut bytes, zip64_eocd_offset);
    append_u32(&mut bytes, 1);

    append_u32(&mut bytes, 0x0605_4b50);
    append_u16(&mut bytes, 0);
    append_u16(&mut bytes, 0);
    append_u16(&mut bytes, u16::MAX);
    append_u16(&mut bytes, u16::MAX);
    append_u32(&mut bytes, u32::MAX);
    append_u32(&mut bytes, u32::MAX);
    append_u16(&mut bytes, 0);
    bytes
}

#[test]
fn accepts_real_compressed_docx_fixture() {
    assert_eq!(preflight_docx_zip(REAL_COMPRESSED_DOCX), Ok(()));
}

#[test]
fn rejects_classic_eocd_entry_limit_before_parsing_central_directory() {
    let mut bytes = Vec::new();
    append_u32(&mut bytes, 0x0605_4b50);
    append_u16(&mut bytes, 0);
    append_u16(&mut bytes, 0);
    append_u16(&mut bytes, 10_001);
    append_u16(&mut bytes, 10_001);
    append_u32(&mut bytes, 0);
    append_u32(&mut bytes, 0);
    append_u16(&mut bytes, 0);

    assert_eq!(
        preflight_docx_zip(&bytes),
        Err("DOCX archive contains more than 10,000 entries".to_string())
    );
}

#[test]
fn rejects_zip64_eocd_entry_limit_before_parsing_central_directory() {
    let mut bytes = Vec::new();
    append_u32(&mut bytes, 0x0606_4b50);
    append_u64(&mut bytes, 44);
    append_u16(&mut bytes, 45);
    append_u16(&mut bytes, 45);
    append_u32(&mut bytes, 0);
    append_u32(&mut bytes, 0);
    append_u64(&mut bytes, 10_001);
    append_u64(&mut bytes, 10_001);
    append_u64(&mut bytes, 0);
    append_u64(&mut bytes, 0);

    append_u32(&mut bytes, 0x0706_4b50);
    append_u32(&mut bytes, 0);
    append_u64(&mut bytes, 0);
    append_u32(&mut bytes, 1);

    append_u32(&mut bytes, 0x0605_4b50);
    append_u16(&mut bytes, 0);
    append_u16(&mut bytes, 0);
    append_u16(&mut bytes, u16::MAX);
    append_u16(&mut bytes, u16::MAX);
    append_u32(&mut bytes, u32::MAX);
    append_u32(&mut bytes, u32::MAX);
    append_u16(&mut bytes, 0);

    assert_eq!(
        preflight_docx_zip(&bytes),
        Err("DOCX archive contains more than 10,000 entries".to_string())
    );
}

#[test]
fn rejects_metadata_count_that_does_not_match_the_central_directory() {
    let mut bytes = one_entry_classic_zip();
    let eocd_offset = bytes.len() - 22;
    bytes[eocd_offset + 8..eocd_offset + 12].fill(0);

    assert_eq!(
        preflight_docx_zip(&bytes),
        Err("DOCX archive is malformed or truncated".to_string())
    );
}

#[test]
fn rejects_classic_shadow_central_directory_before_eocd() {
    let mut bytes = one_entry_classic_zip();
    let eocd_offset = bytes.len() - 22;
    let mut shadow_central_directory = bytes[30..eocd_offset].to_vec();
    shadow_central_directory[24..28].copy_from_slice(&1u32.to_le_bytes());
    bytes.splice(eocd_offset..eocd_offset, shadow_central_directory);

    assert_eq!(
        preflight_docx_zip(&bytes),
        Err("DOCX archive is malformed or truncated".to_string())
    );
}

#[test]
fn accepts_zip64_archive_without_central_directory_gap() {
    assert_eq!(preflight_docx_zip(&one_entry_zip64(false)), Ok(()));
}

#[test]
fn rejects_zip64_shadow_central_directory_before_trailer() {
    assert_eq!(
        preflight_docx_zip(&one_entry_zip64(true)),
        Err("DOCX archive is malformed or truncated".to_string())
    );
}
