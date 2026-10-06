use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value};

use super::{SceneElement, required_string};

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

pub(super) fn validate_bound_elements(
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

pub(super) fn validate_text_container(
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

pub(super) fn validate_arrow_bindings(
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

pub(super) fn validate_real_points(id: &str, object: &Map<String, Value>) -> Result<(), String> {
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
