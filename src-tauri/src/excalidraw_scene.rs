use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value};

const DEFAULT_EXCALIDRAW_SCENE: &str = r#"{"type":"excalidraw","version":2,"source":"mmd","elements":[],"appState":{"viewBackgroundColor":"transparent","currentItemFontFamily":5,"currentItemRoughness":1},"files":{}}"#;

const STANDARD_SCENE_FIELDS: &[&str] =
    &["type", "version", "source", "elements", "appState", "files"];
const STANDARD_ELEMENT_TYPES: &[&str] = &[
    "selection",
    "rectangle",
    "diamond",
    "ellipse",
    "line",
    "arrow",
    "freedraw",
    "text",
    "image",
    "frame",
    "magicframe",
    "embeddable",
    "iframe",
];

struct SceneElement<'a> {
    element_type: &'a str,
    object: &'a Map<String, Value>,
}

pub(crate) fn default_excalidraw_scene() -> &'static str {
    DEFAULT_EXCALIDRAW_SCENE
}

pub(crate) fn validate_excalidraw_scene(content: &str) -> Result<(), String> {
    let scene: Value = serde_json::from_str(content)
        .map_err(|error| format!("Excalidraw scene is not valid JSON: {error}"))?;
    let scene = scene
        .as_object()
        .ok_or_else(|| "Excalidraw scene must be a JSON object".to_string())?;

    validate_scene_container(scene)?;
    let elements = scene
        .get("elements")
        .and_then(Value::as_array)
        .ok_or_else(|| "Excalidraw scene elements must be an array".to_string())?;

    let active = collect_active_elements(elements)?;

    for (id, element) in &active {
        validate_active_element(id, element, &active)?;
    }

    Ok(())
}

fn collect_active_elements(
    elements: &[Value],
) -> Result<HashMap<String, SceneElement<'_>>, String> {
    let mut ids = HashSet::with_capacity(elements.len());
    let mut active = HashMap::with_capacity(elements.len());
    for (index, element) in elements.iter().enumerate() {
        let object = element
            .as_object()
            .ok_or_else(|| format!("Excalidraw element at index {index} must be an object"))?;
        reject_private_label(object, &format!("Excalidraw element at index {index}"))?;
        let id = required_string(object, "id", "Excalidraw element")?;
        if !ids.insert(id.to_string()) {
            return Err(format!(
                "Excalidraw scene contains duplicate element id: {id}"
            ));
        }
        let element_type = required_string(object, "type", "Excalidraw element")?;
        if !STANDARD_ELEMENT_TYPES.contains(&element_type) {
            return Err(format!(
                "Excalidraw element {id} has an unsupported standard type"
            ));
        }
        if is_active(object)? {
            active.insert(
                id.to_string(),
                SceneElement {
                    element_type,
                    object,
                },
            );
        }
    }
    Ok(active)
}

fn validate_active_element(
    id: &str,
    element: &SceneElement<'_>,
    active: &HashMap<String, SceneElement<'_>>,
) -> Result<(), String> {
    validate_bound_elements(id, element, active)?;
    match element.element_type {
        "line" | "arrow" => validate_real_points(id, element.object)?,
        _ => {}
    }
    if element.element_type == "text" {
        validate_text_container(id, element.object, active)?;
    }
    if element.element_type == "arrow" {
        validate_arrow_bindings(id, element.object, active)?;
    }
    Ok(())
}

fn validate_scene_container(scene: &Map<String, Value>) -> Result<(), String> {
    reject_private_label(scene, "Excalidraw scene")?;
    if scene
        .keys()
        .any(|key| !STANDARD_SCENE_FIELDS.contains(&key.as_str()))
    {
        return Err("Excalidraw scene contains nonstandard top-level fields".to_string());
    }
    if scene.get("type").and_then(Value::as_str) != Some("excalidraw") {
        return Err("Excalidraw scene type must be \"excalidraw\"".to_string());
    }
    if scene.get("version").and_then(Value::as_u64) != Some(2) {
        return Err("Excalidraw scene version must be 2".to_string());
    }
    if let Some(source) = scene.get("source") {
        if !source.is_string() {
            return Err("Excalidraw scene source must be a string".to_string());
        }
    }
    if !scene.get("appState").is_some_and(Value::is_object) {
        return Err("Excalidraw scene appState must be an object".to_string());
    }
    if !scene.get("files").is_some_and(Value::is_object) {
        return Err("Excalidraw scene files must be an object".to_string());
    }
    Ok(())
}

fn reject_private_label(object: &Map<String, Value>, context: &str) -> Result<(), String> {
    if object.contains_key("label") {
        return Err(format!("{context} must not contain a private label field"));
    }
    Ok(())
}

fn required_string<'a>(
    object: &'a Map<String, Value>,
    key: &str,
    context: &str,
) -> Result<&'a str, String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("{context} {key} must be a nonempty string"))
}

fn is_active(object: &Map<String, Value>) -> Result<bool, String> {
    match object.get("isDeleted") {
        None | Some(Value::Bool(false)) => Ok(true),
        Some(Value::Bool(true)) => Ok(false),
        Some(_) => Err("Excalidraw element isDeleted must be a boolean".to_string()),
    }
}

mod bindings;

use bindings::{
    validate_arrow_bindings, validate_bound_elements, validate_real_points,
    validate_text_container,
};

#[cfg(test)]
mod tests;
