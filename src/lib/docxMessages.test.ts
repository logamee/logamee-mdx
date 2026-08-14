import { describe, expect, it } from 'vitest';
import packageLock from '../../package-lock.json';
import packageManifest from '../../package.json';
import {
  MAMMOTH_MESSAGE_POLICY_VERSION,
  classifyDocxMessages,
  type DocxConversionMessage,
} from './docxMessages';

describe('DOCX conversion message policy', () => {
  it('is versioned against the exact installed Mammoth dependency', () => {
    expect(packageManifest.dependencies.mammoth).toBe('1.12.0');
    expect(packageLock.packages[''].dependencies.mammoth).toBe('1.12.0');
    expect(packageLock.packages['node_modules/mammoth']?.version).toBe('1.12.0');
    expect(MAMMOTH_MESSAGE_POLICY_VERSION).toBe('mammoth@1.12.0');
  });

  it('detects only dependency-verified exact and prefix warnings that lose content or fidelity', () => {
    const messages: DocxConversionMessage[] = [
      { type: 'warning', message: '\r\n  Could not find image file for a:blip element \r' },
      { type: 'warning', message: 'An unrecognised element was ignored: w:customXml' },
      { type: 'warning', message: 'unexpected non-cell element in table row, cell merging may be incorrect' },
      { type: 'warning', message: 'Image of type image/tiff is unlikely to display in web browsers' },
    ];

    expect(classifyDocxMessages(messages)).toEqual({
      fatal: false,
      detectedLoss: true,
    });
  });

  it('normalizes only line endings and outer whitespace before matching image-loss rules', () => {
    expect(classifyDocxMessages([
      { type: 'warning', message: '\r\n Could not find image file for a:blip element \r' },
    ])).toEqual({ fatal: false, detectedLoss: true });
    expect(classifyDocxMessages([
      { type: 'warning', message: 'Image of type image/tiff is unlikely to display in web browsers' },
    ])).toEqual({ fatal: false, detectedLoss: true });
  });

  it('treats converter errors as fatal without also claiming detected loss', () => {
    expect(classifyDocxMessages([
      { type: 'error', message: 'embedded image failed validation' },
    ])).toEqual({
      fatal: true,
      detectedLoss: false,
    });
  });

  it('treats pinned default-style-map drift as fatal', () => {
    expect(classifyDocxMessages([
      {
        type: 'warning',
        message: '\rDid not understand this style mapping, so ignored it: p.Heading1 => h1:fresh\r\n',
      },
    ])).toEqual({ fatal: true, detectedLoss: false });
  });

  it('does not claim loss for benign or unknown warnings and ignores malformed messages', () => {
    expect(classifyDocxMessages([
      { type: 'warning', message: 'A harmless future Mammoth warning' },
      { type: 'warning', message: "Unrecognised paragraph style: 'Novel' (Style ID: Novel1)" },
      { type: 'warning', message: 'Paragraph style with ID Normal was referenced but not defined in the document' },
      { type: 'warning', message: 'Image of type image/tiff is unlikely to display in native apps' },
      { type: 'warning', message: 'Prefix Image of type image/tiff is unlikely to display in web browsers' },
      { type: 'notice', message: 'not a Mammoth message type' },
      null,
    ])).toEqual({
      fatal: false,
      detectedLoss: false,
    });
  });
});
