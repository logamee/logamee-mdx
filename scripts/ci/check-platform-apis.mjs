// Static audit for platform-specific Rust APIs that must sit under a platform
// cfg gate (`unix`, `windows`, `target_os`, `target_family`, ...). Catches the
// cross-platform compile breakage class where code that compiles on one
// development machine (e.g. macOS) references `std::os::unix`, `libc` symbols
// or Windows-only crates inside scopes that are only gated by `cfg(test)` or
// not gated at all, and then fails native CI on the other platforms.
//
// The audit is a gating-discipline check, not a compile simulator: a reference
// is accepted when ANY platform cfg condition is active on its line, either
// from an attribute on the item itself or from an enclosing `mod`/`fn` scope.
// Individual lines can opt out with a `platform-audit: allow` comment.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const PLATFORM_PATTERNS = [
  { regex: /\bos::unix\b/, label: 'os::unix' },
  { regex: /\bos::windows\b/, label: 'os::windows' },
  { regex: /\blibc::/, label: 'libc::' },
  { regex: /\bwindows_sys::/, label: 'windows_sys::' },
  { regex: /\bwindows_core::/, label: 'windows_core::' },
  { regex: /(?<![A-Za-z0-9_:])windows::/, label: 'windows::' },
  { regex: /\bobjc2_foundation::/, label: 'objc2_foundation::' },
];

const ALLOW_MARKER = 'platform-audit: allow';

export function stripCommentsAndLiterals(source) {
  const lines = source.split('\n');
  const stripped = [];
  let inBlockComment = false;

  for (const line of lines) {
    let result = '';
    let index = 0;
    let blockCommentStartedHere = false;

    while (index < line.length) {
      if (inBlockComment) {
        const end = line.indexOf('*/', index);
        if (end === -1) {
          index = line.length;
        } else {
          inBlockComment = false;
          index = end + 2;
        }
        continue;
      }

      const char = line[index];
      const next = line[index + 1];
      if (char === '/' && next === '*') {
        inBlockComment = true;
        blockCommentStartedHere = true;
        index += 2;
        continue;
      }
      if (char === '/' && next === '/') {
        break;
      }
      result += char;
      index += 1;
    }

    // Blank string and char literals so brace counting and pattern matching
    // only see code. Raw strings are not modelled; the audit errs toward
    // flagging, and real call sites can use the allow marker.
    result = result
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\]|\\.)'/g, "''");

    stripped.push({ text: result, blockCommentStartedHere });
  }

  return stripped;
}

function extractCfgConditions(attributeText) {
  const conditions = [];
  const matcher = /cfg\s*\(/g;
  for (const match of attributeText.matchAll(matcher)) {
    let depth = 1;
    let cursor = match.index + match[0].length;
    while (cursor < attributeText.length && depth > 0) {
      const char = attributeText[cursor];
      if (char === '(') depth += 1;
      if (char === ')') depth -= 1;
      cursor += 1;
    }
    if (depth === 0) {
      conditions.push(attributeText.slice(match.index + match[0].length, cursor - 1).trim());
    }
  }
  return conditions;
}

function isPlatformCondition(condition) {
  return (
    /\b(unix|windows)\b/.test(condition) ||
    /target_[a-z_]+\s*=/.test(condition) ||
    /target_family|target_env|target_arch|target_vendor|target_pointer_width|target_abi/.test(
      condition,
    )
  );
}

function parseAttribute(lineText) {
  // Returns { conditions, remainder } when the line starts with `#[...]`, or
  // null when it does not. Multi-line attributes accumulate in the caller.
  if (!/^\s*#\[/.test(lineText.text)) {
    return null;
  }
  const source = lineText.text;
  const hashIndex = source.indexOf('#[');
  let depth = 0;
  for (let index = hashIndex; index < source.length; index += 1) {
    if (source[index] === '[') depth += 1;
    if (source[index] === ']') {
      depth -= 1;
      if (depth === 0) {
        return {
          conditions: extractCfgConditions(source.slice(hashIndex, index + 1)),
          remainder: source.slice(index + 1),
          complete: true,
        };
      }
    }
  }
  return { conditions: [], remainder: source, complete: false };
}

function classifyGates(conditions) {
  const platform = [];
  const nonPlatform = [];
  for (const condition of conditions) {
    if (isPlatformCondition(condition)) {
      platform.push(condition);
    } else {
      nonPlatform.push(condition);
    }
  }
  return { platform, nonPlatform };
}

export function auditRustSource({ relativePath, source }) {
  const lines = stripCommentsAndLiterals(source);
  const violations = [];
  let depth = 0;
  // cfg conditions in effect for the scope at each depth. Index 0 is the file
  // root (no gates).
  const scopeGates = [[]];
  let pendingAttributes = [];
  let pendingAttrText = '';
  let allowNextLine = false;

  lines.forEach((line, lineIndex) => {
    const lineNumber = lineIndex + 1;
    const originalLine = source.split('\n')[lineIndex] ?? '';

    if (line.blockCommentStartedHere && line.text.trim() === '') {
      return;
    }

    // Multi-line attribute accumulation: keep consuming until brackets close.
    if (pendingAttrText) {
      pendingAttrText += ` ${line.text}`;
      if ((pendingAttrText.match(/\[/g) ?? []).length <= (pendingAttrText.match(/\]/g) ?? []).length) {
        pendingAttributes.push(...extractCfgConditions(pendingAttrText));
        pendingAttrText = '';
      }
      return;
    }

    if (originalLine.includes(ALLOW_MARKER)) {
      allowNextLine = true;
    }

    const attribute = parseAttribute(line);
    if (attribute) {
      if (!attribute.complete) {
        pendingAttrText = line.text;
        return;
      }
      pendingAttributes.push(...attribute.conditions);
      const remainder = attribute.remainder;
      if (remainder.trim() === '') {
        return;
      }
      line = { ...line, text: remainder };
    }

    if (line.text.trim() === '') {
      return;
    }

    const inherited = scopeGates[depth] ?? [];
    const effective = [...inherited, ...pendingAttributes];
    const { platform, nonPlatform } = classifyGates(effective);

    if (!allowNextLine && platform.length === 0) {
      for (const pattern of PLATFORM_PATTERNS) {
        if (pattern.regex.test(line.text)) {
          violations.push({
            file: relativePath,
            line: lineNumber,
            snippet: originalLine.trim(),
            reason: `${pattern.label} reference is not under a platform cfg gate${
              nonPlatform.length > 0
                ? ` (enclosing gates: ${nonPlatform.map((gate) => `cfg(${gate})`).join(', ')})`
                : ''
            }; expected a gate like cfg(unix), cfg(windows) or cfg(target_os = "...")`,
          });
        }
      }
    }
    allowNextLine = false;

    // Track braces one character at a time so mixed lines such as `} else {`
    // push and pop in order. The first push on an item line consumes the
    // pending attribute buffer as the new scope's gate.
    let bufferConsumed = false;
    for (const char of line.text) {
      if (char === '{') {
        depth += 1;
        if (!bufferConsumed) {
          scopeGates[depth] = [...effective];
          // The item scope consumed the attribute buffer; clear it so the
          // gates cannot leak onto later items (e.g. a gateless fn body
          // without any `;` would otherwise smear onto the next item).
          pendingAttributes = [];
          bufferConsumed = true;
        } else {
          scopeGates[depth] = [...(scopeGates[depth - 1] ?? [])];
        }
      } else if (char === '}') {
        scopeGates[depth] = [];
        depth = Math.max(0, depth - 1);
      }
    }

    if (line.text.includes(';')) {
      pendingAttributes = [];
    }
  });

  return { violations };
}

async function listRustFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listRustFiles(entryPath)));
    } else if (entry.name.endsWith('.rs')) {
      files.push(entryPath);
    }
  }
  return files;
}

export async function collectPlatformApiViolations(rootDirectories) {
  const roots = Array.isArray(rootDirectories) ? rootDirectories : [rootDirectories];
  const violations = [];

  for (const root of roots) {
    for (const filePath of await listRustFiles(root)) {
      const source = await readFile(filePath, 'utf8');
      const { violations: fileViolations } = auditRustSource({
        relativePath: filePath,
        source,
      });
      violations.push(...fileViolations);
    }
  }

  return violations;
}

function isMainProcess() {
  return process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
}

if (isMainProcess()) {
  const repoRoot = path.resolve(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)), '../..');
  const roots = [
    path.join(repoRoot, 'src-tauri/src'),
    path.join(repoRoot, 'src-tauri/tests'),
  ].map((root) => root);

  const violations = await collectPlatformApiViolations(roots);

  if (violations.length > 0) {
    console.error(`platform API audit failed with ${violations.length} violation(s):`);
    for (const violation of violations) {
      console.error(`  ${violation.file}:${violation.line} ${violation.snippet}`);
      console.error(`    ${violation.reason}`);
    }
    process.exit(1);
  }

  console.log('platform API audit: no ungated platform-specific APIs found.');
}
