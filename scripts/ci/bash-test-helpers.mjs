import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export function bashPath(value) {
  if (process.platform !== 'win32') return value;
  return value.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
}

export function nativePath(value) {
  if (process.platform !== 'win32') return value;
  // MSYS also maps /tmp, so translating drive prefixes alone is insufficient.
  const result = runBashSync(['-c', 'cygpath -w -- "$1"', '--', value]);
  if (result.status !== 0) throw new Error(`Cannot resolve Bash path: ${result.stderr}`);
  return path.normalize(result.stdout.trim());
}

export function mockBashEnvironment(binDirectory, overrides = {}) {
  const systemPaths = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return {
    ...process.env,
    ...Object.fromEntries(Object.entries(overrides).map(([key, value]) => [key, bashPath(value)])),
    // Keep POSIX tools ahead of Windows utilities such as System32/find.exe.
    MDX_TEST_PATH: [bashPath(binDirectory), '/usr/bin', '/bin', ...systemPaths.map(bashPath)].join(':'),
  };
}

export function runBashSync(args, options = {}) {
  let binary = '/bin/bash';
  if (process.platform === 'win32') {
    binary = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
      .filter(Boolean)
      .map((directory) => path.join(directory, 'Git', 'bin', 'bash.exe'))
      .find((candidate) => existsSync(candidate)) ?? 'bash';
  }
  return spawnSync(binary, args, { encoding: 'utf8', ...options });
}

export function runBashScriptSync(script, args, options) {
  const source = readFileSync(script, 'utf8').replaceAll('\r\n', '\n');
  // Git's Bash launcher prepends its own tools; restore fixture precedence inside Bash.
  const input = 'if [[ -n "${MDX_TEST_PATH:-}" ]]; then export PATH="$MDX_TEST_PATH"; fi\n' + source;
  return runBashSync(['-s', '--', ...args.map(bashPath)], { ...options, input });
}
