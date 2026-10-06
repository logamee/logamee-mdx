//! Shared html-preview test imports.
#[allow(unused_imports)]
pub(crate) use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Write},
    net::TcpStream,
    sync::atomic::Ordering,
};
pub(crate) use tempfile::tempdir;
pub(crate) use crate::{
    commands::{open_directory_inner, rename_workspace_entry_inner},
    models::{MutationKind, MutationOutcome},
    path_auth::{
        authorize_directory_root_inner, authorize_file_inner,
        ensure_authorized_existing_file_inner, ensure_authorized_write_file_inner,
        is_authorized_image_path,
        relocate_authorized_path_prefix_inner, revoke_authorized_file_inner,
        revoke_authorized_path_prefix_inner,
    },
    workspace_index_commands::rebuild_workspace_index_inner,
};
pub(crate) use crate::html_preview_server::{
    acquire_markdown_html_embed_inner, prepare_html_preview_inner,
    prepare_markdown_html_embed_in_workspace_inner, prepare_markdown_html_embed_inner,
    prepare_media_preview_inner, release_markdown_html_embed_inner,
    release_markdown_html_embed_window_inner, release_media_preview_inner,
};
pub(crate) fn http_request(url: &str, method: &str, headers: &[(&str, &str)]) -> Vec<u8> {
    let address_and_path = url.strip_prefix("http://").unwrap();
    let (address, path) = address_and_path.split_once('/').unwrap();
    http_request_with_host(address, path, method, address, headers)
}
pub(crate) fn http_request_with_host(
    address: &str,
    path: &str,
    method: &str,
    host: &str,
    headers: &[(&str, &str)],
) -> Vec<u8> {
    let mut stream = TcpStream::connect(address).unwrap();
    write!(
        stream,
        "{method} /{path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n"
    )
    .unwrap();
    for (name, value) in headers {
        write!(stream, "{name}: {value}\r\n").unwrap();
    }
    write!(stream, "\r\n").unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).unwrap();
    response
}
pub(crate) fn http_get(url: &str) -> String {
    String::from_utf8(http_request(url, "GET", &[])).unwrap()
}
pub(crate) fn response_body(response: &[u8]) -> &[u8] {
    let separator = response
        .windows(4)
        .position(|bytes| bytes == b"\r\n\r\n")
        .unwrap();
    &response[separator + 4..]
}
