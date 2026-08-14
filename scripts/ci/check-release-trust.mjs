import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const UPDATER_ENDPOINT = 'https://github.com/sunlin92/logamee-mdx/releases/latest/download/latest.json';

export function unsignedReleaseConfig() {
  return {
    bundle: {
      createUpdaterArtifacts: false,
    },
    plugins: {
      updater: {
        endpoints: [],
        pubkey: '',
      },
    },
  };
}

const required = [
  'TAURI_SIGNING_PRIVATE_KEY',
  'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
  'TAURI_UPDATER_PUBLIC_KEY',
  'APPLE_CERTIFICATE',
  'APPLE_CERTIFICATE_PASSWORD',
  'APPLE_SIGNING_IDENTITY',
  'APPLE_ID',
  'APPLE_PASSWORD',
  'APPLE_TEAM_ID',
  'WINDOWS_CERTIFICATE_THUMBPRINT',
  'WINDOWS_CERTIFICATE_BASE64',
  'WINDOWS_CERTIFICATE_PASSWORD',
];

function invalid(name, value) {
  return !value?.trim() || value.trim() === '-' || /^(?:replace[-_ ]?me|placeholder|example)$/i.test(value.trim());
}

export function evaluateReleaseTrust(environment) {
  const errors = required
    .filter((name) => invalid(name, environment[name]))
    .map((name) => `${name} must contain a production trust value.`);
  return {
    ready: errors.length === 0,
    errors,
    config: {
      bundle: {
        createUpdaterArtifacts: true,
        windows: { certificateThumbprint: environment.WINDOWS_CERTIFICATE_THUMBPRINT || '' },
      },
      plugins: {
        updater: {
          endpoints: [UPDATER_ENDPOINT],
          pubkey: environment.TAURI_UPDATER_PUBLIC_KEY || '',
        },
      },
    },
  };
}

function main() {
  const outputIndex = process.argv.indexOf('--output');
  const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
  const allowUnsigned = process.argv.includes('--allow-unsigned');
  const result = evaluateReleaseTrust(process.env);
  if (process.argv.includes('--github-output')) {
    const githubOutput = process.env.GITHUB_OUTPUT;
    if (!githubOutput) {
      console.error('GITHUB_OUTPUT is required with --github-output.');
      process.exitCode = 1;
      return;
    }
    fs.appendFileSync(githubOutput, `ready=${result.ready}\n`, 'utf8');
    if (!result.ready) {
      console.log(`::notice::Signed release is disabled because ${result.errors.length} production trust values are not configured.`);
    }
    return;
  }
  if (result.errors.length && !allowUnsigned) {
    for (const error of result.errors) console.error(error);
    process.exitCode = 1;
    return;
  }
  if (allowUnsigned && !output) {
    console.error('--allow-unsigned requires --output.');
    process.exitCode = 1;
    return;
  }
  if (output) {
    const config = result.ready ? result.config : unsignedReleaseConfig();
    if (!result.ready) {
      console.log('Unsigned release fallback is active; updater artifacts and endpoints are disabled.');
    }
    fs.writeFileSync(output, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
