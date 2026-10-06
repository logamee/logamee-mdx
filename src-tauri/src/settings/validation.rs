//! Settings value validation against schema bounds.
use std::path::{Component, Path};
use crate::models::{Settings, SettingsError};
use super::errors::invalid_error;

pub(crate) fn validate_settings(settings: &Settings) -> Result<(), SettingsError> {
    validate_scalar_fields(settings)?;
    validate_resource_directory(settings)?;
    validate_shortcuts(settings)?;
    if !settings.export_profiles.is_empty() {
        return Err(invalid_error(
            "Export profile placeholders must remain empty in this version.",
        ));
    }
    Ok(())
}

fn validate_scalar_fields(settings: &Settings) -> Result<(), SettingsError> {
    if !(250..=60_000).contains(&settings.autosave_delay_ms) {
        return Err(invalid_error(
            "Autosave delay must be between 250 and 60000 milliseconds.",
        ));
    }
    if !matches!(
        settings.autosave_mode.as_str(),
        "afterDelay" | "onFocusChange" | "onWindowChange"
    ) {
        return Err(invalid_error("Autosave mode is not supported."));
    }
    if !settings.editor_pane_ratio.is_finite() || !(0.2..=0.8).contains(&settings.editor_pane_ratio)
    {
        return Err(invalid_error(
            "Editor pane ratio must be between 0.2 and 0.8.",
        ));
    }
    if !(12..=28).contains(&settings.editor_font_size) {
        return Err(invalid_error(
            "Editor font size must be between 12 and 28 pixels.",
        ));
    }
    if !matches!(settings.locale_mode.as_str(), "system" | "zh-CN" | "en") {
        return Err(invalid_error("Locale mode is not supported."));
    }
    if !matches!(
        settings.selected_skin.as_str(),
        "original"
            | "jinxiu-zhusha"
            | "ruyao-tianqing"
            | "qinghua-jilan"
            | "songke-zhuying"
            | "gujuan-nuanxing"
            | "zhuying-qingci"
            | "jiushu-huangzhi"
            | "shanshui-yemo"
    ) {
        return Err(invalid_error("Theme selection is not supported."));
    }
    Ok(())
}

fn validate_resource_directory(settings: &Settings) -> Result<(), SettingsError> {
    if settings.resource_directory.is_empty() || settings.resource_directory.len() > 4096 {
        return Err(invalid_error("Resource directory is invalid."));
    }
    let resource_path = Path::new(&settings.resource_directory);
    if resource_path.components().any(|component| {
        matches!(component, Component::ParentDir | Component::CurDir)
            || (!resource_path.is_absolute()
                && matches!(component, Component::RootDir | Component::Prefix(_)))
    }) {
        return Err(invalid_error(
            "Resource directory must not contain parent traversal.",
        ));
    }
    Ok(())
}

fn validate_shortcuts(settings: &Settings) -> Result<(), SettingsError> {
    const SHORTCUT_DEFAULTS: [(&str, &str); 9] = [
        ("save", "Mod+S"),
        ("saveAs", "Mod+Shift+S"),
        ("quickOpen", "Mod+P"),
        ("workspaceSearch", "Mod+Shift+F"),
        ("export", "Mod+Shift+E"),
        ("settings", "Mod+,"),
        ("editorFontLarger", "Mod+="),
        ("editorFontSmaller", "Mod+-"),
        ("editorFontReset", "Mod+0"),
    ];
    if settings.shortcuts.len() > SHORTCUT_DEFAULTS.len()
        || settings
            .shortcuts
            .keys()
            .any(|action| !SHORTCUT_DEFAULTS.iter().any(|(known, _)| known == action))
    {
        return Err(invalid_error("Shortcut action is not supported."));
    }
    let mut normalized_shortcuts = std::collections::BTreeSet::new();
    for (action, default_shortcut) in SHORTCUT_DEFAULTS {
        let shortcut = settings
            .shortcuts
            .get(action)
            .map(String::as_str)
            .unwrap_or(default_shortcut);
        let normalized = parse_shortcut(shortcut)?;
        if !normalized_shortcuts.insert(normalized) {
            return Err(invalid_error("Shortcut conflicts with another action."));
        }
    }
    Ok(())
}

fn parse_shortcut(shortcut: &str) -> Result<String, SettingsError> {
    let parts = shortcut.split('+').map(str::trim).collect::<Vec<_>>();
    let mut modifiers = parts[..parts.len().saturating_sub(1)]
        .iter()
        .map(|part| part.to_ascii_lowercase())
        .collect::<Vec<_>>();
    let modifiers_are_unique = modifiers
        .iter()
        .collect::<std::collections::BTreeSet<_>>()
        .len()
        == modifiers.len();
    modifiers.sort();
    let modifier_count = modifiers
        .iter()
        .filter(|part| matches!(part.as_str(), "mod" | "ctrl" | "alt" | "shift"))
        .count();
    let key = parts
        .last()
        .copied()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let normalized = format!("{}+{key}", modifiers.join("+"));
    if shortcut.len() > 64
        || parts.len() < 2
        || modifier_count + 1 != parts.len()
        || parts
            .last()
            .is_none_or(|key| key.is_empty() || key.len() > 12)
        || !shortcut_key_is_supported(&key)
        || !modifiers_are_unique
    {
        return Err(invalid_error("Shortcut is invalid."));
    }
    Ok(normalized)
}

fn shortcut_key_is_supported(key: &str) -> bool {
    key.len() == 1
        || matches!(
            key,
            "enter"
                | "escape"
                | "space"
                | "tab"
                | "backspace"
                | "delete"
                | "arrowup"
                | "arrowdown"
                | "arrowleft"
                | "arrowright"
        )
        || (key.starts_with('f')
            && key[1..]
                .parse::<u8>()
                .is_ok_and(|number| (1..=12).contains(&number)))
}
