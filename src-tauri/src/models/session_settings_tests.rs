use serde_json::json;

use super::*;

#[test]
fn workspace_session_restore_always_serializes_an_active_file_field() {
    let restore = WorkspaceSessionRestore {
        workspace: WorkspaceSnapshot {
            workspace_token: "workspace-7".to_string(),
            root: "/workspace".to_string(),
            files: Vec::new(),
            directories: Vec::new(),
        },
        active_file: None,
    };

    assert_eq!(
        serde_json::to_value(restore).unwrap(),
        json!({
            "workspace": {
                "workspace_token": "workspace-7",
                "root": "/workspace",
                "files": [],
                "directories": [],
            },
            "active_file": null,
        })
    );
}

#[test]
fn settings_contract_serializes_camel_case_with_revision_and_structured_errors() {
    let envelope = super::SettingsEnvelope {
        schema_version: 1,
        revision: 7,
        settings: super::Settings::default(),
    };
    let serialized = serde_json::to_value(&envelope).unwrap();
    assert_eq!(
        serialized,
        json!({
            "schemaVersion": 1,
            "revision": 7,
            "settings": {
                "autosaveEnabled": true,
                "autosaveDelayMs": 1000,
                "autosaveMode": "afterDelay",
                "spellcheckEnabled": true,
                "wikilinksEnabled": false,
                "resourceDirectory": "assets",
                "editorPaneRatio": 0.5,
                "editorFontSize": 16,
                "selectedSkin": "original",
                "followSystemTheme": false,
                "localeMode": "system",
                "shortcuts": {},
                "exportProfiles": {}
            }
        })
    );
    assert_eq!(
        serde_json::from_value::<super::SettingsEnvelope>(serialized).unwrap(),
        envelope
    );
    assert_eq!(
        serde_json::to_value(super::SettingsError {
            code: super::SettingsErrorCode::UnsupportedVersion,
            message: "newer settings".to_string(),
            can_reset: false,
        })
        .unwrap(),
        json!({
            "code": "unsupportedVersion",
            "message": "newer settings",
            "canReset": false
        })
    );
}
