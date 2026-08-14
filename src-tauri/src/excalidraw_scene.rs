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

    for (id, element) in &active {
        validate_bound_elements(id, element, &active)?;
        match element.element_type {
            "line" | "arrow" => validate_real_points(id, element.object)?,
            _ => {}
        }
        if element.element_type == "text" {
            validate_text_container(id, element.object, &active)?;
        }
        if element.element_type == "arrow" {
            validate_arrow_bindings(id, element.object, &active)?;
        }
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

fn bound_elements<'a>(
    owner_id: &str,
    object: &'a Map<String, Value>,
) -> Result<Vec<(&'a str, &'a str)>, String> {
    let Some(value) = object.get("boundElements") else {
        return Ok(Vec::new());
    };
    if value.is_null() {
        return Ok(Vec::new());
    }
    let entries = value
        .as_array()
        .ok_or_else(|| format!("Excalidraw element {owner_id} boundElements must be an array"))?;
    let mut seen = HashSet::with_capacity(entries.len());
    let mut result = Vec::with_capacity(entries.len());
    for entry in entries {
        let entry = entry
            .as_object()
            .ok_or_else(|| format!("Excalidraw element {owner_id} has an invalid bound element"))?;
        let id = required_string(entry, "id", "Excalidraw bound element")?;
        let relationship_type = required_string(entry, "type", "Excalidraw bound element")?;
        if relationship_type != "text" && relationship_type != "arrow" {
            return Err(format!(
                "Excalidraw element {owner_id} has an unsupported bound element type"
            ));
        }
        if !seen.insert((id, relationship_type)) {
            return Err(format!(
                "Excalidraw element {owner_id} repeats a bound element"
            ));
        }
        result.push((id, relationship_type));
    }
    Ok(result)
}

fn validate_bound_elements(
    owner_id: &str,
    element: &SceneElement<'_>,
    active: &HashMap<String, SceneElement<'_>>,
) -> Result<(), String> {
    for (bound_id, relationship_type) in bound_elements(owner_id, element.object)? {
        let bound = active.get(bound_id).ok_or_else(|| {
            format!("Excalidraw element {owner_id} references a missing active bound element {bound_id}")
        })?;
        match relationship_type {
            "text" if bound.element_type == "text" => {
                if bound.object.get("containerId").and_then(Value::as_str) != Some(owner_id) {
                    return Err(format!(
                        "Excalidraw bound text {bound_id} does not point back to its container {owner_id}"
                    ));
                }
            }
            "arrow" if bound.element_type == "arrow" => {
                let (start, end) = arrow_binding_targets(bound_id, bound.object)?;
                if start.as_deref() != Some(owner_id) && end.as_deref() != Some(owner_id) {
                    return Err(format!(
                        "Excalidraw bound arrow {bound_id} does not point back to endpoint {owner_id}"
                    ));
                }
            }
            "text" => {
                return Err(format!("Excalidraw bound element {bound_id} must be text"));
            }
            "arrow" => {
                return Err(format!(
                    "Excalidraw bound element {bound_id} must be an arrow"
                ));
            }
            _ => unreachable!("bound_elements validates relationship types"),
        }
    }
    Ok(())
}

fn validate_text_container(
    text_id: &str,
    text: &Map<String, Value>,
    active: &HashMap<String, SceneElement<'_>>,
) -> Result<(), String> {
    let Some(container) = text.get("containerId") else {
        return Ok(());
    };
    if container.is_null() {
        return Ok(());
    }
    let container_id = container
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            format!("Excalidraw text {text_id} containerId must be a nonempty string or null")
        })?;
    let container = active.get(container_id).ok_or_else(|| {
        format!("Excalidraw text {text_id} references a missing active container {container_id}")
    })?;
    if container.element_type == "text" {
        return Err(format!(
            "Excalidraw text {text_id} cannot be bound to text {container_id}"
        ));
    }
    if !bound_elements(container_id, container.object)?
        .iter()
        .any(|(id, relationship_type)| *id == text_id && *relationship_type == "text")
    {
        return Err(format!(
            "Excalidraw text {text_id} is not registered by its container {container_id}"
        ));
    }
    Ok(())
}

fn validate_arrow_bindings(
    arrow_id: &str,
    arrow: &Map<String, Value>,
    active: &HashMap<String, SceneElement<'_>>,
) -> Result<(), String> {
    let (start, end) = arrow_binding_targets(arrow_id, arrow)?;
    for endpoint_id in [start, end].into_iter().flatten() {
        let endpoint = active.get(&endpoint_id).ok_or_else(|| {
            format!(
                "Excalidraw arrow {arrow_id} references a missing active endpoint {endpoint_id}"
            )
        })?;
        if endpoint.element_type == "text" {
            return Err(format!(
                "Excalidraw arrow {arrow_id} endpoint {endpoint_id} must be a shape"
            ));
        }
        if !bound_elements(&endpoint_id, endpoint.object)?
            .iter()
            .any(|(id, relationship_type)| *id == arrow_id && *relationship_type == "arrow")
        {
            return Err(format!(
                "Excalidraw arrow {arrow_id} is not registered by endpoint {endpoint_id}"
            ));
        }
    }
    Ok(())
}

fn arrow_binding_targets(
    arrow_id: &str,
    arrow: &Map<String, Value>,
) -> Result<(Option<String>, Option<String>), String> {
    Ok((
        binding_target(arrow_id, arrow, "startBinding")?,
        binding_target(arrow_id, arrow, "endBinding")?,
    ))
}

fn binding_target(
    arrow_id: &str,
    arrow: &Map<String, Value>,
    key: &str,
) -> Result<Option<String>, String> {
    let Some(binding) = arrow.get(key) else {
        return Ok(None);
    };
    if binding.is_null() {
        return Ok(None);
    }
    let binding = binding
        .as_object()
        .ok_or_else(|| format!("Excalidraw arrow {arrow_id} {key} must be an object or null"))?;
    let target = required_string(binding, "elementId", "Excalidraw arrow binding")?;
    Ok(Some(target.to_string()))
}

fn validate_real_points(id: &str, object: &Map<String, Value>) -> Result<(), String> {
    let points = object
        .get("points")
        .and_then(Value::as_array)
        .ok_or_else(|| format!("Excalidraw line {id} points must be an array"))?;
    if points.len() < 2 {
        return Err(format!(
            "Excalidraw line {id} must contain at least two points"
        ));
    }

    let mut previous = None;
    for point in points {
        let point = point
            .as_array()
            .filter(|point| point.len() == 2)
            .ok_or_else(|| format!("Excalidraw line {id} contains an invalid point"))?;
        let x = point[0]
            .as_f64()
            .filter(|value| value.is_finite())
            .ok_or_else(|| format!("Excalidraw line {id} contains a nonnumeric point"))?;
        let y = point[1]
            .as_f64()
            .filter(|value| value.is_finite())
            .ok_or_else(|| format!("Excalidraw line {id} contains a nonnumeric point"))?;
        if previous.is_some_and(|(previous_x, previous_y)| previous_x == x && previous_y == y) {
            return Err(format!("Excalidraw line {id} contains overlapping points"));
        }
        previous = Some((x, y));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{default_excalidraw_scene, validate_excalidraw_scene};

    fn base_scene(elements: Vec<serde_json::Value>) -> String {
        json!({
            "type": "excalidraw",
            "version": 2,
            "elements": elements,
            "appState": { "viewBackgroundColor": "transparent", "currentItemFontFamily": 5 },
            "files": {},
        })
        .to_string()
    }

    fn base_element(id: &str, element_type: &str) -> serde_json::Value {
        json!({
            "id": id,
            "type": element_type,
            "x": 0,
            "y": 0,
            "width": 100,
            "height": 60,
            "angle": 0,
            "strokeColor": "#1e1e1e",
            "backgroundColor": "transparent",
            "fillStyle": "solid",
            "strokeWidth": 2,
            "strokeStyle": "solid",
            "roughness": 1,
            "opacity": 100,
            "groupIds": [],
            "frameId": null,
            "index": "a0",
            "roundness": null,
            "seed": 1,
            "version": 1,
            "versionNonce": 1,
            "isDeleted": false,
            "boundElements": null,
            "updated": 1,
            "link": null,
            "locked": false,
        })
    }

    fn text_element(id: &str, container_id: Option<&str>) -> serde_json::Value {
        let mut value = base_element(id, "text");
        let object = value.as_object_mut().unwrap();
        object.insert("fontSize".into(), json!(20));
        object.insert("fontFamily".into(), json!(5));
        object.insert("text".into(), json!("中文"));
        object.insert("originalText".into(), json!("中文"));
        object.insert("textAlign".into(), json!("left"));
        object.insert("verticalAlign".into(), json!("top"));
        object.insert(
            "containerId".into(),
            container_id.map_or(serde_json::Value::Null, |value| json!(value)),
        );
        object.insert("autoResize".into(), json!(true));
        object.insert("lineHeight".into(), json!(1.25));
        object.insert("baseline".into(), json!(20));
        value
    }

    fn arrow_element(id: &str, start: Option<&str>, end: Option<&str>) -> serde_json::Value {
        let mut value = base_element(id, "arrow");
        let object = value.as_object_mut().unwrap();
        object.insert("points".into(), json!([[0, 0], [120, 0]]));
        object.insert(
            "startBinding".into(),
            start.map_or(
                serde_json::Value::Null,
                |element_id| json!({ "elementId": element_id, "focus": 0, "gap": 1 }),
            ),
        );
        object.insert(
            "endBinding".into(),
            end.map_or(
                serde_json::Value::Null,
                |element_id| json!({ "elementId": element_id, "focus": 0, "gap": 1 }),
            ),
        );
        object.insert("lastCommittedPoint".into(), serde_json::Value::Null);
        object.insert("startArrowhead".into(), serde_json::Value::Null);
        object.insert("endArrowhead".into(), json!("arrow"));
        value
    }

    #[test]
    fn default_scene_is_a_transparent_version_two_scene_with_chinese_text_defaults() {
        let value: serde_json::Value = serde_json::from_str(&default_excalidraw_scene()).unwrap();

        assert_eq!(value["type"], "excalidraw");
        assert_eq!(value["version"], 2);
        assert_eq!(value["elements"], json!([]));
        assert_eq!(value["appState"]["viewBackgroundColor"], "transparent");
        assert_eq!(value["appState"]["currentItemFontFamily"], 5);
        assert_eq!(value["files"], json!({}));
        validate_excalidraw_scene(&value.to_string()).unwrap();
    }

    #[test]
    fn accepts_standard_scene_with_bidirectional_bound_text_and_arrow_endpoints() {
        let mut start = base_element("start", "rectangle");
        start["boundElements"] = json!([
            { "id": "start-text", "type": "text" },
            { "id": "arrow", "type": "arrow" },
        ]);
        let mut end = base_element("end", "ellipse");
        end["boundElements"] = json!([{ "id": "arrow", "type": "arrow" }]);

        validate_excalidraw_scene(&base_scene(vec![
            start,
            text_element("start-text", Some("start")),
            end,
            arrow_element("arrow", Some("start"), Some("end")),
        ]))
        .unwrap();
    }

    #[test]
    fn rejects_nonstandard_or_structurally_invalid_scenes() {
        let cases = [
            (
                "wrong version",
                json!({ "type": "excalidraw", "version": 1, "elements": [], "appState": {}, "files": {} }).to_string(),
            ),
            (
                "private label",
                base_scene(vec![{
                    let mut element = base_element("shape", "rectangle");
                    element["label"] = json!("not an Excalidraw field");
                    element
                }]),
            ),
            (
                "duplicate id",
                base_scene(vec![base_element("shape", "rectangle"), base_element("shape", "ellipse")]),
            ),
            (
                "bound text only points one way",
                base_scene(vec![base_element("shape", "rectangle"), text_element("text", Some("shape"))]),
            ),
            (
                "bound arrow misses endpoint registration",
                base_scene(vec![
                    base_element("start", "rectangle"),
                    base_element("end", "ellipse"),
                    arrow_element("arrow", Some("start"), Some("end")),
                ]),
            ),
            (
                "degenerate line",
                base_scene(vec![{
                    let mut line = base_element("line", "line");
                    line["points"] = json!([[0, 0], [0, 0]]);
                    line
                }]),
            ),
            (
                "overlapping point before a real segment",
                base_scene(vec![{
                    let mut line = base_element("line", "line");
                    line["points"] = json!([[0, 0], [0, 0], [120, 0]]);
                    line
                }]),
            ),
        ];

        for (name, scene) in cases {
            assert!(validate_excalidraw_scene(&scene).is_err(), "{name}");
        }
    }
}
