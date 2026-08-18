import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const workflowPath = fileURLToPath(
  new URL('../../.github/workflows/platform-ci.yml', import.meta.url),
);
const windowsSmokePath = fileURLToPath(new URL('./smoke-windows.ps1', import.meta.url));
const packagedRunnerPath = fileURLToPath(new URL('./packaged-lifecycle-runner.mjs', import.meta.url));
const packagedOpenRunnerPath = fileURLToPath(new URL('./packaged-open-runner.mjs', import.meta.url));
const tauriLibPath = fileURLToPath(new URL('../../src-tauri/src/lib.rs', import.meta.url));
const tauriConfigPath = fileURLToPath(new URL('../../src-tauri/tauri.conf.json', import.meta.url));
const nativeTrashPath = fileURLToPath(
  new URL('../../src-tauri/src/workspace_trash_native.rs', import.meta.url),
);
const smokePaths = [
  new URL('./smoke-macos.sh', import.meta.url),
  new URL('./smoke-linux.sh', import.meta.url),
  new URL('./smoke-windows.ps1', import.meta.url),
].map(fileURLToPath);

async function workflow() {
  return readFile(workflowPath, 'utf8');
}

async function smokes() {
  return (await Promise.all(smokePaths.map((file) => readFile(file, 'utf8')))).join('\n');
}

test('runs platform CI for main pushes when signed release credentials are unavailable', async () => {
  const value = await workflow();

  assert.match(value, /\n  push:\n/);
  assert.doesNotMatch(value, /branches-ignore:\s*\[main\]/);
});

test('keeps the updater plugin configuration valid in unsigned CI packages', async () => {
  const config = JSON.parse(await readFile(tauriConfigPath, 'utf8'));

  assert.deepEqual(config.plugins?.updater, {
    endpoints: [],
    pubkey: '',
  });
});

test('manages open intents before setup can build webviews', async () => {
  const value = await readFile(tauriLibPath, 'utf8');
  const setupIndex = value.indexOf('.setup(move |app|');
  const manageIndexes = [...value.matchAll(/\.manage\(managed_open_intents\)/g)].map(
    (match) => match.index,
  );

  assert.notEqual(setupIndex, -1, 'the Tauri setup callback must exist');
  assert.equal(manageIndexes.length, 1, 'the coordinator must be managed exactly once');
  assert.ok(
    manageIndexes[0] < setupIndex,
    'the coordinator must be managed before setup can race with webview commands',
  );

  const setupBody = value.slice(setupIndex, value.indexOf('.on_menu_event', setupIndex));
  assert.match(setupBody, /app\.manage\(state\);/);
  assert.doesNotMatch(setupBody, /app\.manage\(managed_open_intents\);/);
});

test('records target-native durable-write CAS and real Trash gates', async () => {
  const value = await workflow();

  assert.match(value, /run-cargo-tests\s+--gate durable-write-cas/);
  assert.match(value, /final_compare_race_retains_complete_competing_bytes/);
  assert.match(value, /expected_absent_install_race_retains_independent_intended_bytes/);
  assert.match(value, /staged_path_substitution_at_native_boundary_preserves_all_complete_images/);
  assert.match(value, /run-cargo-tests\s+--gate native-trash/);
  assert.match(value, /real_native_trash_round_trip_for_file_and_non_empty_directory/);
  assert.match(value, /MMD_RUN_NATIVE_TRASH_SMOKE:\s*'1'/);
});

test('verifies packaged main-binary identity on macOS Windows and Linux', async () => {
  const value = await workflow();

  assert.match(value, /Extract packaged macOS main binary/);
  assert.match(value, /Install and capture packaged Windows main binary/);
  assert.match(value, /Extract packaged Linux main binaries/);
  assert.match(value, /--source-binary/);
  assert.match(value, /--packaged-binary/);
  assert.match(value, /--identity-format macho-text/);
  assert.match(value, /--identity-format pe-text/);
  assert.match(value, /--identity-format elf-text/);
});

test('creates lifecycle evidence after package build and archives it in the manifest', async () => {
  const value = await workflow();
  const build = value.indexOf('- name: Build macOS package');
  const finalize = value.indexOf('- name: Finalize M2 lifecycle evidence');
  const manifest = value.indexOf('- name: Create artifact manifest');
  const upload = value.indexOf('uses: actions/upload-artifact@');

  assert.ok(build !== -1 && finalize > build, 'evidence must be finalized after packaging');
  assert.ok(manifest > finalize, 'artifact manifest must be created after lifecycle evidence');
  assert.ok(upload > manifest, 'artifact upload must follow manifest creation');
  assert.match(value, /m2-lifecycle-evidence\.json/);
  assert.match(value, /artifact-manifest\.mjs create staging/);
  assert.match(value, /artifact-manifest\.mjs verify staging/);
  assert.equal(value.match(/--receipt \.m2-evidence\/cas\.json/g)?.length, 3);
  assert.equal(value.match(/--receipt \.m2-evidence\/trash\.json/g)?.length, 3);
});

test('builds instrumented packages and promotes only post-smoke verified artifacts', async () => {
  const value = await workflow();
  const smoke = await smokes();

  assert.match(value, /VITE_MMD_PACKAGED_LIFECYCLE_E2E:\s*'1'/);
  assert.equal(
    value.match(/npm run tauri -- build[^\n]+--features packaged-lifecycle-e2e/g)?.length,
    2,
  );
  assert.match(smoke, /packaged-lifecycle-runner\.mjs/);
  assert.match(smoke, /verify-packaged/);
  assert.match(value, /name: \$\{\{ matrix\.artifact \}\}-base/);
  assert.match(value, /name: \$\{\{ matrix\.artifact \}\}-verified/);
  assert.match(value, /m2-lifecycle-evidence\.json/);
  assert.ok(
    value.lastIndexOf('uses: actions/upload-artifact@') > value.indexOf('smoke-linux.sh'),
    'verified artifact must be uploaded after packaged smoke verification',
  );
});

test('runs challenge-bound packaged native-open acceptance on every installed package format', async () => {
  const value = await workflow();
  const smoke = await smokes();
  const runner = await readFile(packagedOpenRunnerPath, 'utf8');

  assert.match(value, /VITE_MMD_PACKAGED_OPEN_E2E:\s*'1'/);
  assert.match(smoke, /packaged-open-evidence\.mjs[\s\\`]+issue/);
  assert.match(smoke, /packaged-open-runner\.mjs/);
  for (const profile of ['apply-reobserve', 'restore-cancel']) {
    assert.match(smoke, new RegExp(profile));
    for (const variant of ['dmg', 'nsis', 'deb', 'appimage']) {
      assert.match(smoke, new RegExp(`m3-native-open-${variant}-${profile}\\.json`));
    }
  }
  assert.equal(smoke.match(/packaged-open-runner\.mjs/g)?.length, 4);
  assert.equal(smoke.match(/--profile[\s\S]{0,20}\$profile/g)?.length, 4);
  assert.match(runner, /MMD_PACKAGED_OPEN_E2E_PROFILE/);
  assert.match(runner, /app_settled/);
  assert.match(runner, /queueEmpty/);
  assert.doesNotMatch(runner, /receipt\.observations|receipt\.queue/);
  assert.match(runner, /cli-primary/);
  assert.match(runner, /workspaceDirectory/);
  assert.match(runner, /staleFile/);
  assert.match(runner, /platform-active-window-pid/);
});

test('provides a window manager for Linux active-window evidence', async () => {
  const platform = await workflow();
  const linuxSmoke = await readFile(
    fileURLToPath(new URL('./smoke-linux.sh', import.meta.url)),
    'utf8',
  );
  const xvfbWrapper = await readFile(
    fileURLToPath(new URL('./run-xvfb-with-window-manager.sh', import.meta.url)),
    'utf8',
  );

  assert.match(platform, /apt-get install -y[^\n]*openbox/);
  assert.match(platform, /apt-get install -y[^\n]*xdotool/);
  assert.match(linuxSmoke, /run_with_window_manager/);
  assert.match(xvfbWrapper, /openbox/);
  assert.match(xvfbWrapper, /xprop -root _NET_SUPPORTING_WM_CHECK/);
  assert.doesNotMatch(linuxSmoke, /xvfb-run -a node scripts\/ci\/packaged-open-runner\.mjs/);
});

test('uses platform-native association launchers and limits the AppImage exception by package type', async () => {
  const runner = await readFile(packagedOpenRunnerPath, 'utf8');
  const evidence = await readFile(
    fileURLToPath(new URL('./packaged-open-evidence.mjs', import.meta.url)),
    'utf8',
  );

  assert.match(runner, /command = 'open'/);
  assert.match(runner, /MMD_PACKAGED_OPEN_ASSOCIATION_TARGET: target/);
  assert.match(runner, /Start-Process -FilePath \$env:MMD_PACKAGED_OPEN_ASSOCIATION_TARGET/);
  assert.match(runner, /command = 'gio'/);
  assert.match(evidence, /association\.status !== 'verified'/);
  assert.match(evidence, /appimage-has-no-installed-association/);
  assert.doesNotMatch(evidence, /automation-unavailable|skipped/);
});

test('runs packaged lifecycle feature tests on every native target before packaging', async () => {
  const value = await workflow();
  const featureTest =
    'cargo test --manifest-path src-tauri/Cargo.toml --target ${{ matrix.target }} --release --features packaged-lifecycle-e2e packaged_lifecycle_e2e::tests';
  const featureTestIndex = value.indexOf(featureTest);
  const macosBuildIndex = value.indexOf('- name: Build macOS package');
  const nonMacosBuildIndex = value.indexOf('- name: Build non-macOS package');

  assert.equal(value.split(featureTest).length - 1, 1);
  assert.ok(featureTestIndex !== -1, 'native matrix must run the packaged lifecycle feature tests');
  assert.ok(featureTestIndex < macosBuildIndex, 'feature tests must run before the macOS package build');
  assert.ok(
    featureTestIndex < nonMacosBuildIndex,
    'feature tests must run before the non-macOS package build',
  );
});

test('runs packaged-open feature tests on every native target before packaging', async () => {
  const value = await workflow();
  const featureTest =
    'cargo test --manifest-path src-tauri/Cargo.toml --target ${{ matrix.target }} --release --features packaged-lifecycle-e2e packaged_open_e2e::tests';
  const featureTestIndex = value.indexOf(featureTest);
  const macosBuildIndex = value.indexOf('- name: Build macOS package');
  const nonMacosBuildIndex = value.indexOf('- name: Build non-macOS package');

  assert.equal(value.split(featureTest).length - 1, 1);
  assert.ok(featureTestIndex !== -1, 'native matrix must run the packaged-open feature tests');
  assert.ok(featureTestIndex < macosBuildIndex, 'feature tests must run before the macOS package build');
  assert.ok(
    featureTestIndex < nonMacosBuildIndex,
    'feature tests must run before the non-macOS package build',
  );
});

test('runs packaged-open verifier integration tests on the Windows native runner', async () => {
  const value = await workflow();
  const step = [
    '- name: Windows packaged-open verifier tests',
    "        if: runner.os == 'Windows'",
    '        run: node --test scripts/ci/packaged-open-evidence.node-test.mjs',
  ].join('\n');
  const stepIndex = value.indexOf(step);
  const packageIndex = value.indexOf('- name: Build non-macOS package');

  assert.notEqual(stepIndex, -1, 'Windows must execute the win32-only verifier tests');
  assert.ok(stepIndex < packageIndex, 'Windows verifier tests must pass before packaging');
});

test('passes canonical workflow identity to installed packages and runs both Linux formats', async () => {
  const value = await workflow();

  assert.match(value, /GITHUB_RUN_ID: \$\{\{ github\.run_id \}\}/);
  assert.match(value, /GITHUB_RUN_ATTEMPT: \$\{\{ github\.run_attempt \}\}/);
  assert.match(value, /GITHUB_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(value, /smoke-macos\.sh artifact \$\{\{ matrix\.expected_arch \}\} \$\{\{ matrix\.target \}\}/);
  assert.match(value, /smoke-windows\.ps1 -ArtifactDirectory artifact -Target \$\{\{ matrix\.target \}\}/);
  assert.match(value, /smoke-linux\.sh artifact \$\{\{ matrix\.target \}\}/);
  assert.match(value, /mdx_ci_amd64\.deb/);
  assert.match(value, /mdx_ci_amd64\.AppImage/);
});

test('installs desktop-file-utils for Linux package association smoke tests', async () => {
  const value = await workflow();

  assert.match(value, /sudo apt-get install -y[^\n]*desktop-file-utils/);
});

test('uses the Windows user-local temp volume for packaged Trash fixtures', async () => {
  const value = await readFile(windowsSmokePath, 'utf8');
  const runner = await readFile(packagedRunnerPath, 'utf8');
  const selectLocalTemp = value.indexOf(
    '[Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)',
  );
  const assignLifecycleTemp = value.indexOf(
    "$lifecycleTemp = Join-Path $localAppData 'Temp'",
  );
  const compareSystemVolume = value.indexOf('if ($lifecycleVolume -ine $systemVolume)');
  const createLifecycleTemp = value.indexOf(
    'New-Item -ItemType Directory -Path $lifecycleTemp -Force',
  );
  const runPackagedLifecycle = value.indexOf('packaged-lifecycle-runner.mjs');

  assert.notEqual(selectLocalTemp, -1, 'Windows smoke must select LocalApplicationData');
  assert.notEqual(assignLifecycleTemp, -1, 'Windows smoke must use LocalApplicationData\\Temp');
  assert.notEqual(compareSystemVolume, -1, 'Windows smoke must enforce the system volume');
  assert.notEqual(createLifecycleTemp, -1, 'Windows smoke must create the lifecycle temp');
  assert.ok(
    selectLocalTemp < assignLifecycleTemp
      && assignLifecycleTemp < compareSystemVolume
      && compareSystemVolume < createLifecycleTemp
      && createLifecycleTemp < runPackagedLifecycle,
    'the system-volume lifecycle temp must be prepared before the packaged app starts',
  );
  assert.match(value, /\$systemVolume = \[IO\.Path\]::GetPathRoot\(\[Environment\]::SystemDirectory\)/);
  assert.match(value, /\$lifecycleVolume = \[IO\.Path\]::GetPathRoot\(\$lifecycleTemp\)/);
  assert.match(value, /\$env:TEMP = \$lifecycleTemp/);
  assert.match(value, /\$env:TMP = \$lifecycleTemp/);
  assert.match(value, /\$env:TMPDIR = \$lifecycleTemp/);
  assert.match(runner, /Packaged lifecycle challenge root:/);
});

test('keeps raw Windows Trash diagnostics behind packaged lifecycle instrumentation', async () => {
  const value = await readFile(nativeTrashPath, 'utf8');
  const gatedDiagnostics = [
    '        #[cfg(feature = "packaged-lifecycle-e2e")]',
    '        match &result {',
    '            MoveToTrash::Rejected { error } => {',
    '                eprintln!("Packaged lifecycle Windows Trash rejected: {error}");',
    '            }',
    '            MoveToTrash::PossiblyMoved { error, .. } => {',
    '                eprintln!("Packaged lifecycle Windows Trash was not proven: {error}");',
    '            }',
    '            MoveToTrash::Placed { .. } => {}',
    '        }',
    '        result',
    '    }',
  ].join('\n');

  assert.ok(
    value.includes(gatedDiagnostics),
    'raw Windows Trash diagnostics must remain inside the packaged lifecycle feature gate',
  );
});
