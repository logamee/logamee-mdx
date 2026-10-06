//! Construction and refresh of the app-wide native menu.
use tauri::{
    menu::{CheckMenuItemBuilder, Menu, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder},
    AppHandle, Runtime,
};

use super::{
    MENU_LANGUAGE_ID, MENU_VIEW_ID, MENU_APPEARANCE_ID, MENU_FILE_ID,
    MENU_OPEN_RECENT_PREFIX, MENU_CLEAR_RECENT_ID, MENU_SAVE_AS_ID, MENU_SAVE_ID,
    MENU_WORKSPACE_SEARCH_ID, MENU_QUICK_OPEN_ID, MENU_OPEN_DIRECTORY_ID, MENU_OPEN_FILE_ID,
    MENU_NEW_ID,
    SAVE_MENU_SYNC_ERROR, NativeMenuState, appearance_menu_items,
    language_menu_items, apply_save_menu_enabled,
};
use crate::models::RecentFilesSnapshot;

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
    let (open_file, open_directory) = build_file_open_items(app, chinese)?;
    let (quick_open, workspace_search) = build_file_search_items(app, state, chinese)?;
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

fn build_file_open_items<R: Runtime>(
    app: &AppHandle<R>,
    chinese: bool,
) -> tauri::Result<(tauri::menu::MenuItem<R>, tauri::menu::MenuItem<R>)> {
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
    Ok((open_file, open_directory))
}

fn build_file_search_items<R: Runtime>(
    app: &AppHandle<R>,
    state: &NativeMenuState,
    chinese: bool,
) -> tauri::Result<(tauri::menu::MenuItem<R>, tauri::menu::MenuItem<R>)> {
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
    Ok((quick_open, workspace_search))
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
