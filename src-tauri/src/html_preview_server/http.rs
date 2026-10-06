use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
};

use tiny_http::{Header, Request, Response, StatusCode};

use crate::workspace_file_kind::WorkspaceFileKind;
use super::HtmlPreviewContent;

pub(crate) fn header(name: &[u8], value: impl AsRef<[u8]>) -> Header {
    Header::from_bytes(name, value.as_ref()).expect("static preview response header is valid")
}

pub(crate) fn respond_bytes(request: Request, status: u16, mime_type: &str, body: Vec<u8>) {
    let length = body.len();
    let response = Response::new(
        StatusCode(status),
        vec![
            header(b"Content-Type", mime_type),
            header(b"Cache-Control", b"no-store"),
            header(b"X-Content-Type-Options", b"nosniff"),
        ],
        std::io::Cursor::new(body),
        Some(length),
        None,
    );
    let _ = request.respond(response);
}

pub(crate) fn requested_byte_range(request: &Request, length: usize) -> Result<Option<(usize, usize)>, ()> {
    let Some(value) = request
        .headers()
        .iter()
        .find(|header| header.field.equiv("Range"))
        .map(|header| header.value.as_str())
    else {
        return Ok(None);
    };
    let Some(range) = value.strip_prefix("bytes=") else {
        return Err(());
    };
    if length == 0 || range.contains(',') {
        return Err(());
    }
    let (start, end) = range.split_once('-').ok_or(())?;
    if start.is_empty() {
        let suffix = end.parse::<usize>().map_err(|_| ())?;
        if suffix == 0 {
            return Err(());
        }
        let start = length.saturating_sub(suffix);
        return Ok(Some((start, length - 1)));
    }
    let start = start.parse::<usize>().map_err(|_| ())?;
    if start >= length {
        return Err(());
    }
    let end = if end.is_empty() {
        length - 1
    } else {
        end.parse::<usize>().map_err(|_| ())?.min(length - 1)
    };
    if end < start {
        return Err(());
    }
    Ok(Some((start, end)))
}

fn preview_file_headers(
    mime_type: &str,
    range: Option<(usize, usize)>,
    length: usize,
    allow_cors: bool,
) -> Vec<Header> {
    let mut headers = match range {
        Some((start, end)) => vec![
            header(b"Content-Type", mime_type),
            header(b"Content-Range", format!("bytes {start}-{end}/{length}")),
        ],
        None => vec![header(b"Content-Type", mime_type)],
    };
    headers.push(header(b"Accept-Ranges", b"bytes"));
    if allow_cors {
        headers.push(header(b"Access-Control-Allow-Origin", b"*"));
        headers.push(header(b"Access-Control-Expose-Headers", b"Content-Range"));
    }
    headers.push(header(b"Cache-Control", b"no-store"));
    headers.push(header(b"X-Content-Type-Options", b"nosniff"));
    headers
}

pub(crate) fn respond_file(
    request: Request,
    mime_type: &str,
    mut file: File,
    length: usize,
    allow_cors: bool,
) {
    match requested_byte_range(&request, length) {
        Ok(Some((start, end))) => {
            if file.seek(SeekFrom::Start(start as u64)).is_err() {
                respond_bytes(
                    request,
                    404,
                    "text/plain; charset=utf-8",
                    b"Not found".to_vec(),
                );
                return;
            }
            let range_length = end - start + 1;
            let headers = preview_file_headers(mime_type, Some((start, end)), length, allow_cors);
            let response = Response::new(
                StatusCode(206),
                headers,
                file.take(range_length as u64),
                Some(range_length),
                None,
            );
            let _ = request.respond(response);
        }
        Ok(None) => {
            let headers = preview_file_headers(mime_type, None, length, allow_cors);
            let response = Response::new(StatusCode(200), headers, file, Some(length), None);
            let _ = request.respond(response);
        }
        Err(()) => {
            let response = Response::new(
                StatusCode(416),
                vec![
                    header(b"Content-Type", b"text/plain; charset=utf-8"),
                    header(b"Content-Range", format!("bytes */{length}")),
                    header(b"Cache-Control", b"no-store"),
                    header(b"X-Content-Type-Options", b"nosniff"),
                ],
                std::io::Cursor::new(Vec::new()),
                Some(0),
                None,
            );
            let _ = request.respond(response);
        }
    }
}

pub(crate) fn request_is_local(request: &Request, authority: &str) -> bool {
    let local_client = request
        .remote_addr()
        .is_some_and(|address| address.ip().is_loopback());
    let valid_host = request
        .headers()
        .iter()
        .find(|header| header.field.equiv("Host"))
        .is_some_and(|header| header.value.as_str() == authority);
    local_client && valid_host
}

mod open_file;
mod routing;

use open_file::open_authorized_file;
use routing::{guard_preview_request, resolve_requested_file, respond_live_draft};
#[cfg(test)]
pub(crate) use open_file::open_authorized_file_with;

pub(crate) fn route_request(
    request: Request,
    authority: &str,
    root: &Path,
    document: &Path,
    content: &HtmlPreviewContent,
    media_access_token: Option<&str>,
) {
    let Some(request) = guard_preview_request(request, authority, media_access_token) else {
        return;
    };
    let (file, metadata, canonical) = match resolve_requested_file(&request, root) {
        Ok(opened) => opened,
        Err((status, body)) => {
            respond_bytes(request, status, "text/plain; charset=utf-8", body.to_vec());
            return;
        }
    };

    if canonical == document {
        if let HtmlPreviewContent::LiveDraft(content) = content {
            respond_live_draft(request, content);
            return;
        }
    }

    let mime = mime_guess::from_path(&canonical).first_or_octet_stream();
    let allow_media_cors = canonical == document
        && matches!(
            WorkspaceFileKind::classify(document),
            Some(WorkspaceFileKind::Video | WorkspaceFileKind::Audio)
        );
    respond_file(
        request,
        mime.as_ref(),
        file,
        metadata.len() as usize,
        allow_media_cors,
    );
}
