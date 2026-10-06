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
    assert_default_menu_projection(&state);

    state.set_theme_preference("qinghua-jilan", true).unwrap();
    state.set_save_enabled(true);
    state.set_recent_files(RecentFilesSnapshot { entries: vec![] });

    assert_custom_skin_projection(&state);
    state.set_locale_preference("zh-CN", "zh-CN").unwrap();
    assert_custom_locale_projection(&mut state);

    state.set_save_enabled(false);
    state.set_recent_files(RecentFilesSnapshot { entries: vec![] });
    assert_projection_survives_full_rebuild_inputs(&mut state);
}

fn assert_default_menu_projection(state: &NativeMenuState) {
    assert_eq!(state.selected_skin(), "original");
    assert!(!state.follow_system());
    assert_eq!(state.locale_mode(), "system");
    assert_eq!(state.effective_locale(), "en");
}

fn assert_custom_skin_projection(state: &NativeMenuState) {
    assert_eq!(state.selected_skin(), "qinghua-jilan");
    assert!(state.follow_system());
}

fn assert_custom_locale_projection(state: &mut NativeMenuState) {
    assert_eq!(state.locale_mode(), "zh-CN");
    assert_eq!(state.effective_locale(), "zh-CN");
    assert!(state.set_locale_preference("fr", "en").is_err());
    assert!(state.set_locale_preference("en", "fr").is_err());
    assert!(state.save_enabled());
    assert!(state.recent_files().entries.is_empty());
}

fn assert_projection_survives_full_rebuild_inputs(state: &mut NativeMenuState) {
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
