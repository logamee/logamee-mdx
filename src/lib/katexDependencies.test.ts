import { describe, expect, it } from 'vitest';
import packageLock from '../../package-lock.json';
import packageManifest from '../../package.json';

const lockedPackages = packageLock.packages as Record<string, { version?: string } | undefined>;

describe('KaTeX dependency alignment', () => {
  it('uses one stylesheet-compatible KaTeX version for Markdown preview rendering', () => {
    const version = packageManifest.dependencies.katex;

    expect(version).toBe('0.18.1');
    expect(packageManifest.overrides).toEqual({
      'rehype-katex': { katex: version },
    });
    expect(lockedPackages['node_modules/katex']?.version).toBe(version);
    expect(lockedPackages['node_modules/rehype-katex/node_modules/katex']).toBeUndefined();
  });
});
