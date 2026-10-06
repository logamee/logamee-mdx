import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { auditRustSource, collectPlatformApiViolations } from './check-platform-apis.mjs';

const repoSrcRoot = fileURLToPath(new URL('../../src-tauri/src', import.meta.url));

function violationsFor(source) {
  return auditRustSource({ relativePath: 'fixture.rs', source }).violations;
}

test('flags an os::unix import that only sits under cfg(test)', () => {
  const source = [
    '#[cfg(test)]',
    'mod tests {',
    '    use super::{copy_entry, CopyEntryError};',
    '    use std::{fs, os::unix::fs::symlink};',
    '}',
  ].join('\n');

  const violations = violationsFor(source);

  assert.equal(violations.length, 1);
  assert.equal(violations[0].line, 4);
  assert.match(violations[0].reason, /os::unix/);
  assert.match(violations[0].reason, /cfg\(test\)/);
});

test('accepts an os::unix import gated by cfg(unix) on the same item', () => {
  const source = [
    'mod tests {',
    '    use std::fs;',
    '    #[cfg(unix)]',
    '    use std::os::unix::fs::symlink;',
    '}',
  ].join('\n');

  assert.deepEqual(violationsFor(source), []);
});

test('accepts platform APIs inside a target_os gated module', () => {
  const source = [
    '#[cfg(any(target_os = "linux", target_os = "macos"))]',
    'mod unix_only {',
    '    fn open_parent() {',
    "        let flags = libc::O_DIRECTORY | libc::O_NOFOLLOW;",
    '    }',
    '}',
  ].join('\n');

  assert.deepEqual(violationsFor(source), []);
});

test('flags an ungated libc reference inside a plain function', () => {
  const source = [
    'fn create_pipe(directory: &Path) {',
    '    let name = CString::new(directory.to_str().unwrap()).unwrap();',
    '    unsafe {',
    '        libc::mkfifo(name.as_ptr(), 0o600);',
    '    }',
    '}',
  ].join('\n');

  const violations = violationsFor(source);

  assert.equal(violations.length, 1);
  assert.equal(violations[0].line, 4);
  assert.match(violations[0].reason, /libc::/);
});

test('accepts a libc reference under a cfg(unix) function', () => {
  const source = [
    '#[cfg(unix)]',
    'fn create_pipe(directory: &Path) {',
    '    unsafe {',
    '        libc::mkfifo(name.as_ptr(), 0o600);',
    '    }',
    '}',
  ].join('\n');

  assert.deepEqual(violationsFor(source), []);
});

test('flags an ungated os::windows import', () => {
  const source = ['use std::{', '    io,', '    os::windows::ffi::OsStrExt,', '};'].join('\n');

  const violations = violationsFor(source);

  assert.equal(violations.length, 1);
  assert.match(violations[0].reason, /os::windows/);
});

test('accepts a cfg(windows) gated os::windows import', () => {
  const source = [
    '#[cfg(windows)]',
    'mod windows_handle_files {',
    '    use std::os::windows::{ffi::OsStrExt, io::AsRawHandle};',
    '}',
  ].join('\n');

  assert.deepEqual(violationsFor(source), []);
});

test('keeps the cfg gate active across a multi-line use tree', () => {
  const source = [
    '#[cfg(any(target_os = "linux", target_os = "macos"))]',
    'use std::{',
    '    ffi::CString,',
    '    os::unix::{ffi::OsStrExt, fs::OpenOptionsExt},',
    '    path::PathBuf,',
    '};',
    '',
    'fn ungated_after() {',
    '    use std::os::unix::fs::symlink;',
    '}',
  ].join('\n');

  const violations = violationsFor(source);

  assert.equal(violations.length, 1);
  assert.equal(violations[0].line, 9);
});

test('flags an os::unix use tree whose gate was closed before the sensitive line', () => {
  const source = [
    '#[cfg(unix)]',
    'fn gated() {',
    '    let _ = 1;',
    '}',
    '',
    'fn ungated() {',
    '    use std::os::unix::fs::symlink;',
    '    let _ = symlink;',
    '}',
  ].join('\n');

  const violations = violationsFor(source);

  assert.equal(violations.length, 1);
  assert.equal(violations[0].line, 7);
});

test('cfg(test) is not treated as a platform gate for libc', () => {
  const source = [
    '#[cfg(test)]',
    'mod tests {',
    '    #[test]',
    '    fn rejects_fifo() {',
    '        unsafe {',
    '            libc::mkfifo(name.as_ptr(), 0o600);',
    '        }',
    '    }',
    '}',
  ].join('\n');

  const violations = violationsFor(source);

  assert.equal(violations.length, 1);
  assert.match(violations[0].reason, /cfg\(test\)/);
});

test('comments and string literals do not trigger violations', () => {
  const source = [
    '// use std::os::unix::fs::symlink;',
    '/// See [`std::os::unix::fs::symlink`] for the gated twin.',
    'fn report() -> String {',
    '    String::from("use std::os::unix::fs::symlink;")',
    '}',
  ].join('\n');

  assert.deepEqual(violationsFor(source), []);
});

test('an explicit allow marker suppresses the line', () => {
  const source = [
    'fn documented_divergence() {',
    '    // platform-audit: allow example-only reference, never compiled',
    '    let _ = "libc::mkfifo";',
    '}',
  ].join('\n');

  assert.deepEqual(violationsFor(source), []);
});

test('nested platform gates on inner items are honoured', () => {
  const source = [
    '#[cfg(unix)]',
    'mod outer {',
    '    fn still_gated() {',
    '        libc::sysconf(libc::_SC_PAGESIZE);',
    '    }',
    '',
    '    #[cfg(target_os = "macos")]',
    '    fn mac_only() {',
    '        libc::mach_host();',
    '    }',
    '}',
  ].join('\n');

  assert.deepEqual(violationsFor(source), []);
});

test('collectPlatformApiViolations scans the current repository clean', async () => {
  const violations = await collectPlatformApiViolations(repoSrcRoot);

  assert.deepEqual(
    violations,
    [],
    `ungated platform-specific APIs found:\n${violations
      .map((violation) => `${violation.file}:${violation.line} ${violation.snippet}`)
      .join('\n')}`,
  );
});
