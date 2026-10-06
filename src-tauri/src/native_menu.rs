use std::collections::BTreeMap;


use crate::models::RecentFilesSnapshot;

pub const NATIVE_MENU_EVENT: &str = "mmd-native-menu";
pub const MENU_NEW_ID: &str = "new";
pub const MENU_OPEN_FILE_ID: &str = "open-file";
pub const MENU_OPEN_DIRECTORY_ID: &str = "open-directory";
pub const MENU_QUICK_OPEN_ID: &str = "quick-open";
pub const MENU_WORKSPACE_SEARCH_ID: &str = "workspace-search";
pub const MENU_SAVE_ID: &str = "save";
pub const MENU_SAVE_AS_ID: &str = "save-as";
pub const MENU_CLEAR_RECENT_ID: &str = "clear-recent-files";
pub const MENU_OPEN_RECENT_PREFIX: &str = "open-recent:";
const MENU_FILE_ID: &str = "mmd-file";
const MENU_VIEW_ID: &str = "mmd-view";
const MENU_APPEARANCE_ID: &str = "mmd-appearance";
const MENU_LANGUAGE_ID: &str = "mmd-language";
pub const MENU_THEME_SKIN_PREFIX: &str = "theme-skin:";
pub const MENU_THEME_FOLLOW_SYSTEM_ID: &str = "theme-follow-system";
pub const MENU_LOCALE_PREFIX: &str = "locale:";
const SAVE_MENU_SYNC_ERROR: &str = "Native save menu synchronization failed";

const SKINS: [(&str, &str); 9] = [
    ("original", "素笺·青黛"),
    ("jinxiu-zhusha", "朱批·丹砂"),
    ("ruyao-tianqing", "汝瓷·天青"),
    ("qinghua-jilan", "青花·苏青"),
    ("songke-zhuying", "宋版·竹青"),
    ("gujuan-nuanxing", "杏笺·赭石"),
    ("zhuying-qingci", "春笺·豆青"),
    ("jiushu-huangzhi", "烟岚·缃素"),
    ("shanshui-yemo", "玄卷·松烟"),
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MenuRoute {
    MainFile,
    MainThemeAuthority,
    MainLocaleAuthority,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeMenuState {
    recent_files: RecentFilesSnapshot,
    save_enabled: bool,
    selected_skin: String,
    follow_system: bool,
    locale_mode: String,
    effective_locale: String,
    shortcuts: BTreeMap<String, String>,
}

impl Default for NativeMenuState {
    fn default() -> Self {
        Self {
            recent_files: RecentFilesSnapshot {
                entries: Vec::new(),
            },
            save_enabled: false,
            selected_skin: "original".to_string(),
            follow_system: false,
            locale_mode: "system".to_string(),
            effective_locale: "en".to_string(),
            shortcuts: BTreeMap::new(),
        }
    }
}

impl NativeMenuState {
    pub fn recent_files(&self) -> &RecentFilesSnapshot {
        &self.recent_files
    }

    pub fn save_enabled(&self) -> bool {
        self.save_enabled
    }

    pub fn selected_skin(&self) -> &str {
        &self.selected_skin
    }

    pub fn follow_system(&self) -> bool {
        self.follow_system
    }

    pub fn locale_mode(&self) -> &str {
        &self.locale_mode
    }

    pub fn effective_locale(&self) -> &str {
        &self.effective_locale
    }

    pub fn shortcut(&self, action: &str, default: &'static str) -> String {
        self.shortcuts
            .get(action)
            .map(|value| value.replace("Mod+", "CmdOrCtrl+"))
            .unwrap_or_else(|| default.to_string())
    }

    pub fn set_recent_files(&mut self, recent_files: RecentFilesSnapshot) {
        self.recent_files = recent_files;
    }

    pub fn set_shortcuts(&mut self, shortcuts: BTreeMap<String, String>) {
        self.shortcuts = shortcuts;
    }

    pub fn set_save_enabled(&mut self, enabled: bool) {
        self.save_enabled = enabled;
    }

    pub fn set_theme_preference(
        &mut self,
        selected_skin: &str,
        follow_system: bool,
    ) -> Result<(), String> {
        if !is_skin_id(selected_skin) {
            return Err("Invalid native theme preference".to_string());
        }
        self.selected_skin = selected_skin.to_string();
        self.follow_system = follow_system;
        Ok(())
    }

    pub fn set_locale_preference(
        &mut self,
        mode: &str,
        effective_locale: &str,
    ) -> Result<(), String> {
        if !is_locale_mode(mode) || !is_effective_locale(effective_locale) {
            return Err("Invalid native locale preference".to_string());
        }
        self.locale_mode = mode.to_string();
        self.effective_locale = effective_locale.to_string();
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AppearanceItemKind {
    Skin,
    FollowSystem,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AppearanceMenuItem {
    pub id: String,
    pub label: &'static str,
    pub checked: bool,
    pub kind: AppearanceItemKind,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageMenuItem {
    pub id: String,
    pub label: &'static str,
    pub checked: bool,
}

pub fn language_menu_items(state: &NativeMenuState) -> Vec<LanguageMenuItem> {
    let chinese = state.effective_locale() == "zh-CN";
    [
        (
            "system",
            if chinese {
                "跟随系统"
            } else {
                "Follow System"
            },
        ),
        ("zh-CN", "中文"),
        ("en", "English"),
    ]
    .into_iter()
    .map(|(mode, label)| LanguageMenuItem {
        id: format!("{MENU_LOCALE_PREFIX}{mode}"),
        label,
        checked: state.locale_mode() == mode,
    })
    .collect()
}

pub fn appearance_menu_items(state: &NativeMenuState) -> Vec<AppearanceMenuItem> {
    let mut items = SKINS
        .iter()
        .map(|(skin, label)| AppearanceMenuItem {
            id: format!("{MENU_THEME_SKIN_PREFIX}{skin}"),
            label,
            checked: state.selected_skin() == *skin,
            kind: AppearanceItemKind::Skin,
        })
        .collect::<Vec<_>>();
    items.push(AppearanceMenuItem {
        id: MENU_THEME_FOLLOW_SYSTEM_ID.to_string(),
        label: if state.effective_locale() == "zh-CN" {
            "跟随系统"
        } else {
            "Follow System"
        },
        checked: state.follow_system(),
        kind: AppearanceItemKind::FollowSystem,
    });
    items
}

fn apply_save_menu_enabled(
    enabled: bool,
    mut set_enabled: impl FnMut(&str, bool) -> Result<(), String>,
) -> Result<(), String> {
    set_enabled(MENU_SAVE_ID, enabled)?;
    set_enabled(MENU_SAVE_AS_ID, enabled)
}

pub fn action_for_menu_id(id: &str) -> Option<String> {
    match id {
        MENU_NEW_ID
        | MENU_OPEN_FILE_ID
        | MENU_OPEN_DIRECTORY_ID
        | MENU_QUICK_OPEN_ID
        | MENU_WORKSPACE_SEARCH_ID
        | MENU_SAVE_ID
        | MENU_SAVE_AS_ID
        | MENU_CLEAR_RECENT_ID => Some(id.to_string()),
        _ if id
            .strip_prefix(MENU_OPEN_RECENT_PREFIX)
            .is_some_and(is_opaque_id) =>
        {
            Some(id.to_string())
        }
        MENU_THEME_FOLLOW_SYSTEM_ID => Some(id.to_string()),
        _ if id
            .strip_prefix(MENU_THEME_SKIN_PREFIX)
            .is_some_and(is_skin_id) =>
        {
            Some(id.to_string())
        }
        _ if id
            .strip_prefix(MENU_LOCALE_PREFIX)
            .is_some_and(is_locale_mode) =>
        {
            Some(id.to_string())
        }
        _ => None,
    }
}

pub fn route_for_menu_id(id: &str) -> Option<MenuRoute> {
    action_for_menu_id(id).map(|_| {
        if id.starts_with(MENU_LOCALE_PREFIX) {
            MenuRoute::MainLocaleAuthority
        } else if id == MENU_THEME_FOLLOW_SYSTEM_ID || id.starts_with(MENU_THEME_SKIN_PREFIX) {
            MenuRoute::MainThemeAuthority
        } else {
            MenuRoute::MainFile
        }
    })
}

#[cfg(test)]
mod tests;
mod builder;

pub(crate) use builder::{build_app_menu, refresh_app_menu, set_save_menu_enabled};

fn is_opaque_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_skin_id(value: &str) -> bool {
    SKINS.iter().any(|(skin, _)| *skin == value)
}

fn is_locale_mode(value: &str) -> bool {
    matches!(value, "system" | "zh-CN" | "en")
}

fn is_effective_locale(value: &str) -> bool {
    matches!(value, "zh-CN" | "en")
}
