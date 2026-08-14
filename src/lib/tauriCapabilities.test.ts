// @ts-expect-error Vitest executes this contract in Node; the app tsconfig excludes Node globals.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import capability from '../../src-tauri/capabilities/default.json';
import tauriConfig from '../../src-tauri/tauri.conf.json';

const cargoManifest = readFileSync(new URL('../../src-tauri/Cargo.toml', import.meta.url), 'utf8');
const tauriRustLib = readFileSync(new URL('../../src-tauri/src/lib.rs', import.meta.url), 'utf8');
const resourceStore = readFileSync(new URL('../../src-tauri/src/resource_store.rs', import.meta.url), 'utf8');

function releaseProfiles() {
  return [...cargoManifest.matchAll(
    /^\[profile\.release\]\s*$\n?([\s\S]*?)(?=^\[|(?![\s\S]))/gmu,
  )].map((match) => match[1]
    .split('\n')
    .map((line: string) => line.trim())
    .filter(Boolean));
}

describe('Tauri capabilities', () => {
  it('injects the current window metadata required by the bundled Tauri API', () => {
    expect(tauriConfig.app.withGlobalTauri).toBe(true);
  });

  it('allows focusing an already-open popout window', () => {
    expect(capability.permissions).toContain('core:window:allow-set-focus');
  });

  it('enables local preview streaming with an empty default asset scope', () => {
    expect(tauriConfig.app.security.assetProtocol).toEqual({ enable: true, scope: [] });
    expect(tauriConfig.app.security.csp).toContain("media-src 'self' asset: http://asset.localhost");
    expect(tauriConfig.app.security.csp).toContain("frame-src 'self' asset: http://asset.localhost http://127.0.0.1:*");
  });

  it('packages the generated desktop icon set on every supported platform', () => {
    expect(tauriConfig.bundle.icon).toEqual([
      'icons/32x32.png',
      'icons/128x128.png',
      'icons/128x128@2x.png',
      'icons/icon.icns',
      'icons/icon.ico',
    ]);
  });

  it('packages Markdown associations and pins the Rust-only single-instance plugin', () => {
    expect((tauriConfig.bundle as Record<string, unknown>).fileAssociations).toEqual([{
      description: 'Markdown Document',
      ext: ['md', 'mdx', 'markdown', 'mdown', 'mkd'],
      mimeType: 'text/markdown',
      name: 'Markdown Document',
      rank: 'Default',
      role: 'Editor',
    }]);
    expect(cargoManifest.match(/^tauri-plugin-single-instance = "=2\.4\.3"$/gm)).toHaveLength(1);
    expect(tauriRustLib.indexOf('.plugin(tauri_plugin_single_instance::init(')).toBeGreaterThan(0);
    expect(tauriRustLib.indexOf('.plugin(tauri_plugin_single_instance::init('))
      .toBeLessThan(tauriRustLib.indexOf('.plugin(tauri_plugin_dialog::init())'));
  });

  it('keeps native watching backend-only with exact dependency pins', () => {
    expect(cargoManifest.match(/^notify = "=8\.2\.0"$/gm)).toHaveLength(1);
    expect(cargoManifest.match(/^notify-debouncer-full = "=0\.7\.0"$/gm)).toHaveLength(1);
    expect(cargoManifest).not.toContain('tauri-plugin-fs');
    expect(capability.permissions.some((permission) => (
      permission.includes('fs:watch') || permission.includes('watch-fs')
    ))).toBe(false);
  });

  it('uses only the behavior-preserving release size settings', () => {
    expect(releaseProfiles()).toEqual([[
      'codegen-units = 1',
      'lto = true',
      'opt-level = "s"',
      'strip = true',
    ]]);
    expect(cargoManifest).not.toMatch(/^panic\s*=\s*"abort"$/gmu);
  });

  it('keeps every command available without broadening capabilities or bundle targets', () => {
    expect((tauriConfig.build as Record<string, unknown>).removeUnusedCommands).toBeUndefined();
    expect(capability.permissions).toEqual([
      'core:default',
      'core:webview:allow-create-webview-window',
      'core:window:allow-destroy',
      'core:window:allow-set-focus',
      'process:allow-restart',
      'updater:default',
    ]);
    expect(tauriConfig.bundle.targets).toBe('all');
  });

  it('registers only the process permission needed to relaunch after an update', () => {
    expect(cargoManifest).toMatch(/^tauri-plugin-process = "=2\.3\.1"$/m);
    expect(tauriRustLib).toContain('.plugin(tauri_plugin_process::init())');
    expect(capability.permissions.filter((permission) => permission.startsWith('process:')))
      .toEqual(['process:allow-restart']);
  });

  it('keeps macOS no-replace resource publication bound to the authorized directory handle', () => {
    expect(resourceStore).toContain('libc::renameatx_np(');
    expect(resourceStore).not.toContain('read_link(format!("/dev/fd/{}", directory.as_raw_fd()))');
  });
});
