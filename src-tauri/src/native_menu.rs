use std::collections::BTreeMap;
use tauri::{
    menu::{CheckMenuItemBuilder, Menu, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder},
    AppHandle, Runtime,
};

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

pub fn build_app_menu<R: Runtime>(
    app: &AppHandle<R>,
    state: &NativeMenuState,
) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    let file_menu = build_file_menu_with_locale(
        app,
        state.recent_files(),
        state.save_enabled(),
        state.effective_locale() == "zh-CN",
        state,
    )?;
    let view_menu = build_view_menu(app, state)?;

    #[cfg(target_os = "macos")]
    {
        let _ = menu.remove_at(1)?;
        menu.insert(&file_menu, 1)?;
        let _ = menu.remove_at(3)?;
        menu.insert(&view_menu, 3)?;
    }

    #[cfg(target_os = "windows")]
    {
        let _ = menu.remove_at(0)?;
        menu.insert(&file_menu, 0)?;
        menu.append(&view_menu)?;
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        menu.prepend(&file_menu)?;
        menu.append(&view_menu)?;
    }

    Ok(menu)
}

pub fn refresh_app_menu<R: Runtime>(
    app: &AppHandle<R>,
    state: &NativeMenuState,
) -> tauri::Result<()> {
    app.set_menu(build_app_menu(app, state)?)?;
    Ok(())
}

fn build_view_menu<R: Runtime>(
    app: &AppHandle<R>,
    state: &NativeMenuState,
) -> tauri::Result<tauri::menu::Submenu<R>> {
    let chinese = state.effective_locale() == "zh-CN";
    let mut appearance = SubmenuBuilder::with_id(
        app,
        MENU_APPEARANCE_ID,
        if chinese { "外观" } else { "Appearance" },
    );
    for item in appearance_menu_items(state) {
        let check = CheckMenuItemBuilder::with_id(item.id, item.label)
            .checked(item.checked)
            .build(app)?;
        appearance = appearance.item(&check);
    }
    let appearance = appearance.build()?;
    let mut language = SubmenuBuilder::with_id(
        app,
        MENU_LANGUAGE_ID,
        if chinese { "语言" } else { "Language" },
    );
    for item in language_menu_items(state) {
        let check = CheckMenuItemBuilder::with_id(item.id, item.label)
            .checked(item.checked)
            .build(app)?;
        language = language.item(&check);
    }
    let language = language.build()?;
    let view =
        SubmenuBuilder::with_id(app, MENU_VIEW_ID, if chinese { "显示" } else { "View" })
            .item(&appearance)
            .item(&language);
    #[cfg(target_os = "macos")]
    let view = {
        let fullscreen = PredefinedMenuItem::fullscreen(app, None)?;
        view.separator().item(&fullscreen)
    };
    view.build()
}

pub fn set_save_menu_enabled<R: Runtime>(app: &AppHandle<R>, enabled: bool) -> Result<(), String> {
    let menu = app.menu().ok_or_else(save_menu_sync_error)?;
    let file_menu = match menu.get(MENU_FILE_ID) {
        Some(tauri::menu::MenuItemKind::Submenu(file_menu)) => file_menu,
        _ => return Err(save_menu_sync_error()),
    };
    apply_save_menu_enabled(enabled, |id, value| {
        let item = match file_menu.get(id) {
            Some(tauri::menu::MenuItemKind::MenuItem(item)) => item,
            _ => return Err(save_menu_sync_error()),
        };
        item.set_enabled(value).map_err(|_| save_menu_sync_error())
    })
}

fn save_menu_sync_error() -> String {
    SAVE_MENU_SYNC_ERROR.to_string()
}

fn build_file_menu_with_locale<R: Runtime>(
    app: &AppHandle<R>,
    recent_files: &RecentFilesSnapshot,
    save_enabled: bool,
    chinese: bool,
    state: &NativeMenuState,
) -> tauri::Result<tauri::menu::Submenu<R>> {
    let new = MenuItemBuilder::with_id(MENU_NEW_ID, if chinese { "新建" } else { "New" })
        .accelerator("CmdOrCtrl+N")
        .build(app)?;
    let open_file = MenuItemBuilder::with_id(
        MENU_OPEN_FILE_ID,
        if chinese {
            "打开文件…"
        } else {
            "Open File…"
        },
    )
    .accelerator("CmdOrCtrl+O")
    .build(app)?;
    let open_directory = MenuItemBuilder::with_id(
        MENU_OPEN_DIRECTORY_ID,
        if chinese {
            "打开文件夹…"
        } else {
            "Open Directory…"
        },
    )
    .accelerator("CmdOrCtrl+Shift+O")
    .build(app)?;
    let quick_open = MenuItemBuilder::with_id(
        MENU_QUICK_OPEN_ID,
        if chinese {
            "快速打开…"
        } else {
            "Quick Open…"
        },
    )
    .accelerator(state.shortcut("quickOpen", "CmdOrCtrl+P"))
    .build(app)?;
    let workspace_search = MenuItemBuilder::with_id(
        MENU_WORKSPACE_SEARCH_ID,
        if chinese {
            "搜索工作区…"
        } else {
            "Search Workspace…"
        },
    )
    .accelerator(state.shortcut("workspaceSearch", "CmdOrCtrl+Shift+F"))
    .build(app)?;
    let open_recent = build_open_recent_menu(app, recent_files, chinese)?;
    let save = MenuItemBuilder::with_id(MENU_SAVE_ID, if chinese { "保存" } else { "Save" })
        .accelerator(state.shortcut("save", "CmdOrCtrl+S"))
        .enabled(save_enabled)
        .build(app)?;
    let save_as = MenuItemBuilder::with_id(
        MENU_SAVE_AS_ID,
        if chinese {
            "另存为…"
        } else {
            "Save As…"
        },
    )
    .accelerator(state.shortcut("saveAs", "CmdOrCtrl+Shift+S"))
    .enabled(save_enabled)
    .build(app)?;
    let close_window = PredefinedMenuItem::close_window(app, None)?;

    SubmenuBuilder::with_id(app, MENU_FILE_ID, if chinese { "文件" } else { "File" })
        .item(&new)
        .item(&open_file)
        .item(&open_recent)
        .item(&open_directory)
        .separator()
        .item(&quick_open)
        .item(&workspace_search)
        .separator()
        .item(&save)
        .item(&save_as)
        .separator()
        .item(&close_window)
        .build()
}

fn build_open_recent_menu<R: Runtime>(
    app: &AppHandle<R>,
    recent_files: &RecentFilesSnapshot,
    chinese: bool,
) -> tauri::Result<tauri::menu::Submenu<R>> {
    let mut menu = SubmenuBuilder::with_id(
        app,
        "mmd-open-recent",
        if chinese {
            "最近打开"
        } else {
            "Open Recent"
        },
    );
    if recent_files.entries.is_empty() {
        let empty = MenuItemBuilder::new(if chinese {
            "没有最近文件"
        } else {
            "No Recent Files"
        })
        .enabled(false)
        .build(app)?;
        menu = menu.item(&empty);
    } else {
        for entry in &recent_files.entries {
            let item = MenuItemBuilder::with_id(
                format!("{MENU_OPEN_RECENT_PREFIX}{}", entry.id),
                &entry.display_name,
            )
            .build(app)?;
            menu = menu.item(&item);
        }
        let clear = MenuItemBuilder::with_id(
            MENU_CLEAR_RECENT_ID,
            if chinese {
                "清除最近文件"
            } else {
                "Clear Recent Files"
            },
        )
        .build(app)?;
        menu = menu.separator().item(&clear);
    }
    menu.build()
}

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn maps_only_known_native_file_menu_ids_to_frontend_actions() {
        assert_eq!(action_for_menu_id("new"), Some("new".to_string()));
        assert_eq!(
            action_for_menu_id("open-file"),
            Some("open-file".to_string())
        );
        assert_eq!(
            action_for_menu_id(MENU_QUICK_OPEN_ID),
            Some(MENU_QUICK_OPEN_ID.to_string())
        );
        assert_eq!(
            action_for_menu_id(MENU_WORKSPACE_SEARCH_ID),
            Some(MENU_WORKSPACE_SEARCH_ID.to_string())
        );
        assert_eq!(
            action_for_menu_id("open-recent:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
            Some("open-recent:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string())
        );
        assert_eq!(
            action_for_menu_id("clear-recent-files"),
            Some("clear-recent-files".to_string())
        );
        assert_eq!(action_for_menu_id("open-recent:/tmp/note.md"), None);
        assert_eq!(action_for_menu_id("quit"), None);
    }

    #[test]
    fn maps_only_allow_listed_theme_ids_and_routes_them_to_main_authority() {
        assert_eq!(
            action_for_menu_id("theme-skin:original"),
            Some("theme-skin:original".to_string())
        );
        assert_eq!(
            action_for_menu_id("theme-skin:gujuan-nuanxing"),
            Some("theme-skin:gujuan-nuanxing".to_string())
        );
        assert_eq!(
            action_for_menu_id("theme-skin:jinxiu-zhusha"),
            Some("theme-skin:jinxiu-zhusha".to_string())
        );
        assert_eq!(
            action_for_menu_id("theme-skin:shanshui-yemo"),
            Some("theme-skin:shanshui-yemo".to_string())
        );
        assert_eq!(
            action_for_menu_id("theme-follow-system"),
            Some("theme-follow-system".to_string())
        );
        assert_eq!(action_for_menu_id("theme-skin:unknown"), None);
        assert_eq!(action_for_menu_id("theme-follow-system:true"), None);
        assert_eq!(route_for_menu_id("open-file"), Some(MenuRoute::MainFile));
        assert_eq!(
            route_for_menu_id("theme-skin:ruyao-tianqing"),
            Some(MenuRoute::MainThemeAuthority)
        );
    }

    #[test]
    fn maps_only_allow_listed_locale_ids_to_main_locale_authority() {
        for mode in ["system", "zh-CN", "en"] {
            let id = format!("locale:{mode}");
            assert_eq!(action_for_menu_id(&id), Some(id.clone()));
            assert_eq!(route_for_menu_id(&id), Some(MenuRoute::MainLocaleAuthority));
        }
        assert_eq!(action_for_menu_id("locale:fr"), None);
        assert_eq!(action_for_menu_id("locale:"), None);
    }

    #[test]
    fn native_menu_state_preserves_theme_projection_across_full_rebuild_inputs() {
        let mut state = NativeMenuState::default();
        assert_eq!(state.selected_skin(), "original");
        assert!(!state.follow_system());
        assert_eq!(state.locale_mode(), "system");
        assert_eq!(state.effective_locale(), "en");

        state.set_theme_preference("qinghua-jilan", true).unwrap();
        state.set_save_enabled(true);
        state.set_recent_files(RecentFilesSnapshot { entries: vec![] });

        assert_eq!(state.selected_skin(), "qinghua-jilan");
        assert!(state.follow_system());
        state.set_locale_preference("zh-CN", "zh-CN").unwrap();
        assert_eq!(state.locale_mode(), "zh-CN");
        assert_eq!(state.effective_locale(), "zh-CN");
        assert!(state.set_locale_preference("fr", "en").is_err());
        assert!(state.set_locale_preference("en", "fr").is_err());
        assert!(state.save_enabled());
        assert!(state.recent_files().entries.is_empty());

        state.set_save_enabled(false);
        state.set_recent_files(RecentFilesSnapshot { entries: vec![] });
        assert_eq!(state.selected_skin(), "qinghua-jilan");
        assert!(state.follow_system());
        assert!(state.set_theme_preference("not-a-skin", false).is_err());
        assert_eq!(state.selected_skin(), "qinghua-jilan");
        assert!(state.follow_system());
    }

    #[test]
    fn native_menu_state_projects_custom_primary_modifier_shortcuts() {
        let mut state = NativeMenuState::default();
        assert_eq!(state.shortcut("save", "CmdOrCtrl+S"), "CmdOrCtrl+S");
        state.set_shortcuts(BTreeMap::from([
            ("save".to_string(), "Mod+Shift+P".to_string()),
            ("quickOpen".to_string(), "Ctrl+Alt+Q".to_string()),
        ]));
        assert_eq!(state.shortcut("save", "CmdOrCtrl+S"), "CmdOrCtrl+Shift+P");
        assert_eq!(state.shortcut("quickOpen", "CmdOrCtrl+P"), "Ctrl+Alt+Q");
        assert_eq!(
            state.shortcut("saveAs", "CmdOrCtrl+Shift+S"),
            "CmdOrCtrl+Shift+S"
        );
    }

    #[test]
    fn appearance_items_are_single_select_and_include_follow_system() {
        let state = NativeMenuState::default();
        let items = appearance_menu_items(&state);
        assert_eq!(items.len(), 10);
        assert_eq!(
            items
                .iter()
                .filter(|item| item.kind == AppearanceItemKind::Skin)
                .map(|item| item.label)
                .collect::<Vec<_>>(),
            vec![
                "素笺·青黛",
                "朱批·丹砂",
                "汝瓷·天青",
                "青花·苏青",
                "宋版·竹青",
                "杏笺·赭石",
                "春笺·豆青",
                "烟岚·缃素",
                "玄卷·松烟",
            ]
        );
        assert_eq!(
            items
                .iter()
                .filter(|item| item.kind == AppearanceItemKind::Skin && item.checked)
                .count(),
            1
        );
        assert!(items.iter().any(|item| item.id == "theme-follow-system"));
        assert_eq!(
            items
                .iter()
                .filter(|item| item.kind == AppearanceItemKind::Skin)
                .count(),
            9
        );
    }

    #[test]
    fn language_items_are_single_select_and_localize_system_label() {
        let mut state = NativeMenuState::default();
        let items = language_menu_items(&state);
        assert_eq!(items.len(), 3);
        assert_eq!(items.iter().filter(|item| item.checked).count(), 1);
        assert_eq!(
            items.iter().find(|item| item.checked).unwrap().id,
            "locale:system"
        );
        assert_eq!(items[0].label, "Follow System");

        state.set_locale_preference("zh-CN", "zh-CN").unwrap();
        let items = language_menu_items(&state);
        assert_eq!(
            items.iter().find(|item| item.checked).unwrap().id,
            "locale:zh-CN"
        );
        assert_eq!(items[0].label, "跟随系统");
    }

    #[test]
    fn applies_save_availability_to_both_existing_menu_items_idempotently() {
        let mut states = BTreeMap::new();
        let mut calls = Vec::new();
        let mut apply = |enabled| {
            apply_save_menu_enabled(enabled, |id, value| {
                states.insert(id.to_string(), value);
                calls.push((id.to_string(), value));
                Ok(())
            })
        };

        apply(false).unwrap();
        apply(true).unwrap();
        apply(true).unwrap();

        assert_eq!(states.get(MENU_SAVE_ID), Some(&true));
        assert_eq!(states.get(MENU_SAVE_AS_ID), Some(&true));
        assert_eq!(
            calls,
            vec![
                (MENU_SAVE_ID.to_string(), false),
                (MENU_SAVE_AS_ID.to_string(), false),
                (MENU_SAVE_ID.to_string(), true),
                (MENU_SAVE_AS_ID.to_string(), true),
                (MENU_SAVE_ID.to_string(), true),
                (MENU_SAVE_AS_ID.to_string(), true),
            ]
        );
    }
}
