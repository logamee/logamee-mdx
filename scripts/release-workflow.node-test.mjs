import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const workflowPath = fileURLToPath(
  new URL('../.github/workflows/release.yml', import.meta.url),
);

async function readPublisher() {
  const workflow = await readFile(workflowPath, 'utf8');
  const publisherStart = workflow.indexOf('\n  publish-latest:');

  assert.notEqual(publisherStart, -1, 'publish-latest job is missing');
  return workflow.slice(publisherStart);
}

async function readPublishScript() {
  const publisher = await readPublisher();
  const step = publisher.indexOf('      - name: Create, verify, and roll Latest\n');
  assert.notEqual(step, -1, 'publish transaction step is missing');

  const runMarker = '        run: |\n';
  const scriptStart = publisher.indexOf(runMarker, step);
  assert.notEqual(scriptStart, -1, 'publish transaction script is missing');

  const script = [];
  for (const line of publisher.slice(scriptStart + runMarker.length).split('\n')) {
    if (line.startsWith('          ')) {
      script.push(line.slice(10));
    } else if (line === '') {
      script.push('');
    } else {
      break;
    }
  }
  return `${script.join('\n')}\n`;
}

function readShellFunction(publisher, name) {
  const marker = `          ${name}() {\n`;
  const start = publisher.indexOf(marker);
  assert.notEqual(start, -1, `${name} function is missing`);

  const end = publisher.indexOf('\n          }\n', start);
  assert.notEqual(end, -1, `${name} function is unterminated`);
  return publisher.slice(start, end + '\n          }'.length);
}

test('source-free publisher gives every gh release command an explicit repository', async () => {
  const publisher = await readPublisher();
  assert.doesNotMatch(publisher, /uses:\s*actions\/checkout@/);

  const releaseCommands = publisher
    .split('\n')
    .filter((line) => /\bgh release (?:create|delete|download|edit)\b/.test(line));

  assert.ok(releaseCommands.length > 0, 'publisher has no gh release commands');
  for (const command of releaseCommands) {
    assert.match(command, /--repo "\$GITHUB_REPOSITORY"/);
  }

  const createCommand = releaseCommands.find((command) => /\bgh release create\b/.test(command));
  assert.match(createCommand ?? '', /--verify-tag/);
});

test('draft candidate metadata is read by release ID instead of the published-tag endpoint', async () => {
  const publisher = await readPublisher();
  const resolver = readShellFunction(publisher, 'find_candidate_release_id');
  const rollback = readShellFunction(publisher, 'delete_candidate_release_or_confirm_absent');

  assert.doesNotMatch(
    publisher,
    /repos\/\$GITHUB_REPOSITORY\/releases\/tags\/\$tag\b/,
  );
  assert.match(publisher, /candidate_release_id=\$\(retry find_candidate_release_id\)/);
  assert.match(resolver, /gh api --paginate "repos\/\$GITHUB_REPOSITORY\/releases\?per_page=100" --slurp/);
  assert.match(resolver, /select\(\.tag_name == \$tag\)/);
  assert.match(resolver, /if length == 1 then \.\[0\]\.id/);
  assert.match(
    publisher,
    /candidate_draft=\$\(gh api "repos\/\$GITHUB_REPOSITORY\/releases\/\$candidate_release_id" --jq \.draft\)/,
  );
  assert.match(
    publisher,
    /gh api -X DELETE "repos\/\$GITHUB_REPOSITORY\/releases\/\$candidate_release_id"/,
  );
  assert.match(
    publisher,
    /retry gh api -X PATCH "repos\/\$GITHUB_REPOSITORY\/releases\/\$candidate_release_id" -F draft=false -f make_latest=true/,
  );
  assert.match(rollback, /if \[\[ "\$candidate_release_id" =~ \^\[0-9\]\+\$ \]\]/);
  const idDelete = rollback.indexOf('gh api -X DELETE "repos/$GITHUB_REPOSITORY/releases/$candidate_release_id"');
  const tagFallback = rollback.indexOf('gh release delete "$tag"');
  assert.ok(idDelete !== -1 && tagFallback > idDelete);
  assert.match(rollback, /fi\n            candidate_release_absent\n          \}$/);
});

test('embedded publish transaction is valid Bash', async () => {
  const result = spawnSync('bash', ['-n'], {
    input: await readPublishScript(),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
});

test('release smoke jobs use non-instrumented mode and pass every required native target', async () => {
  const workflow = await readFile(workflowPath, 'utf8');

  assert.match(
    workflow,
    /smoke-macos\.sh artifact arm64 aarch64-apple-darwin release/,
  );
  assert.match(
    workflow,
    /smoke-macos\.sh artifact x86_64 x86_64-apple-darwin release/,
  );
  assert.match(
    workflow,
    /smoke-windows\.ps1 -ArtifactDirectory artifact -Target x86_64-pc-windows-msvc -Mode release/,
  );
  assert.match(
    workflow,
    /smoke-linux\.sh artifact x86_64-unknown-linux-gnu release/,
  );
});

test('release builds fall back to unsigned installers without weakening trusted releases', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  assert.match(workflow, /release-ready: \$\{\{ steps\.release-trust\.outputs\.ready \}\}/);
  assert.match(workflow, /id: release-trust[\s\S]*check-release-trust\.mjs --github-output/);
  assert.doesNotMatch(
    workflow,
    /build-(?:macos-arm64|macos-x64|windows-x64|linux-x64):[\s\S]{0,150}if: needs\.source\.outputs\.release-ready == 'true'/,
  );
  assert.equal(
    workflow.match(/check-release-trust\.mjs --allow-unsigned --output src-tauri\/tauri\.release\.conf\.json/g)?.length,
    4,
  );
  assert.equal(
    workflow.match(/check-release-trust\.mjs --allow-unsigned --output src-tauri\/tauri\.release\.conf\.json\n\s+env: \*trusted-release-env/g)?.length,
    4,
  );
  assert.match(workflow, /TAURI_SIGNING_PRIVATE_KEY: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY \}\}/);
  assert.match(workflow, /APPLE_CERTIFICATE: \$\{\{ secrets\.APPLE_CERTIFICATE \}\}/);
  assert.match(workflow, /WINDOWS_CERTIFICATE_BASE64: \$\{\{ secrets\.WINDOWS_CERTIFICATE_BASE64 \}\}/);
  assert.equal(
    workflow.match(/name: Build signed (?:macOS|Windows|Linux) package/g)?.length,
    4,
  );
  assert.equal(
    workflow.match(/name: Build unsigned (?:macOS|Windows|Linux) package/g)?.length,
    4,
  );
  assert.equal(
    workflow.match(/name: Build unsigned macOS package[\s\S]{0,240}APPLE_SIGNING_IDENTITY: '-'/g)?.length,
    2,
  );
  assert.doesNotMatch(workflow, /runs-on: (?:macos|windows|ubuntu)[^\n]*\n\s+env: \*trusted-release-env/);
  assert.match(
    workflow,
    /name: Import and verify Windows signing certificate\n\s+if: needs\.source\.outputs\.release-ready == 'true'[\s\S]{0,500}env: \*trusted-release-env/,
  );
  assert.match(workflow, /if \[\[ "\$RELEASE_READY" == true \]\]; then/);
  assert.match(workflow, /scripts\/ci\/smoke-linux\.sh artifact x86_64-unknown-linux-gnu release/);
  assert.match(workflow, /create-update-manifest\.mjs release-assets/);
  assert.match(workflow, /"latest\.json"/);
});
