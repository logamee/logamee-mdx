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
