import { describe, expect, it } from 'vitest';
import packageLock from '../../package-lock.json';
import packageManifest from '../../package.json';

const expectedCodeMirrorVersions = {
  '@codemirror/commands': '6.11.1',
  '@codemirror/lang-html': '6.4.12',
  '@codemirror/lang-markdown': '6.5.2',
  '@codemirror/language': '6.12.4',
  '@codemirror/search': '6.7.2',
  '@codemirror/state': '6.7.6',
  '@codemirror/view': '6.43.13',
} as const;

describe('CodeMirror dependency pins', () => {
  it('keeps direct declarations and lockfile packages on the approved exact versions', () => {
    for (const [name, version] of Object.entries(expectedCodeMirrorVersions)) {
      expect(packageManifest.dependencies[name as keyof typeof packageManifest.dependencies])
        .toBe(version);
      expect(packageLock.packages[''].dependencies[name as keyof typeof packageLock.packages['']['dependencies']])
        .toBe(version);
      expect(packageLock.packages[`node_modules/${name}` as keyof typeof packageLock.packages]?.version)
        .toBe(version);
    }
  });

  it('keeps Markdown input assistance on the already pinned local primitives', () => {
    expect(Object.prototype.hasOwnProperty.call(packageManifest.dependencies, '@codemirror/autocomplete')).toBe(false);
    expect(packageManifest.dependencies['@codemirror/state']).toBe(expectedCodeMirrorVersions['@codemirror/state']);
    expect(packageManifest.dependencies['@codemirror/view']).toBe(expectedCodeMirrorVersions['@codemirror/view']);
  });
});
