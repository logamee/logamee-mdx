//! Request admission, path resolution and live-draft responses for the
//! preview HTTP routes.
use std::{
    fs::File,
    path::{Component, Path, PathBuf},
    sync::Mutex,
};

use tiny_http::{Method, Request, Response, StatusCode};

use percent_encoding::percent_decode_str;

use super::{header, open_authorized_file, request_is_local, respond_bytes};
use super::super::MEDIA_ACCESS_TOKEN_QUERY;

pub(super) fn guard_preview_request(
    request: Request,
    authority: &str,
    media_access_token: Option<&str>,
) -> Option<Request> {
    if !request_is_local(&request, authority) {
        respond_bytes(
            request,
            421,
            "text/plain; charset=utf-8",
            b"Misdirected request".to_vec(),
        );
        return None;
    }
    if let Some(expected_token) = media_access_token {
        let authorized = request.url().split_once('?').is_some_and(|(_, query)| {
            query.split('&').any(|parameter| {
                parameter.split_once('=').is_some_and(|(name, value)| {
                    name == MEDIA_ACCESS_TOKEN_QUERY && value == expected_token
                })
            })
        });
        if !authorized {
            respond_bytes(
                request,
                403,
                "text/plain; charset=utf-8",
                b"Forbidden".to_vec(),
            );
            return None;
        }
    }
    if !matches!(request.method(), Method::Get | Method::Head) {
        let response = Response::new(
            StatusCode(405),
            vec![
                header(b"Content-Type", b"text/plain; charset=utf-8"),
                header(b"Allow", b"GET, HEAD"),
                header(b"Cache-Control", b"no-store"),
                header(b"X-Content-Type-Options", b"nosniff"),
            ],
            std::io::Cursor::new(b"Method not allowed".to_vec()),
            Some(18),
            None,
        );
        let _ = request.respond(response);
        return None;
    }
    Some(request)
}

pub(super) fn resolve_requested_file(
    request: &Request,
    root: &Path,
) -> Result<(File, std::fs::Metadata, PathBuf), (u16, &'static [u8])> {
    let encoded_path = request.url().split('?').next().unwrap_or_default();
    let Ok(decoded_path) = percent_decode_str(encoded_path).decode_utf8() else {
        return Err((400, b"Invalid path"));
    };
    let relative_path = decoded_path.trim_start_matches('/');
    if relative_path.is_empty() {
        return Err((404, b"Not found"));
    }
    let relative = Path::new(relative_path);
    if relative
        .components()
        .any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
    {
        return Err((403, b"Forbidden"));
    }
    let requested = root.join(relative);
    match open_authorized_file(&requested, root) {
        Ok(opened) => Ok(opened),
        _ => Err((404, b"Not found")),
    }
}

pub(super) fn respond_live_draft(request: Request, content: &Mutex<String>) {
    let live_content = match content.lock() {
        Ok(content) => content.clone(),
        Err(_) => {
            respond_bytes(
                request,
                500,
                "text/plain; charset=utf-8",
                b"Preview unavailable".to_vec(),
            );
            return;
        }
    };
    respond_bytes(
        request,
        200,
        "text/html; charset=utf-8",
        live_content.into_bytes(),
    );
}
