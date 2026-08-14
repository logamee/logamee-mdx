// @vitest-environment jsdom

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import mammoth from 'mammoth';
import { afterEach, describe, expect, it, vi } from 'vitest';
import packageManifest from '../package.json';
import fixtureManifest from '../test-fixtures/p2/docx/manifest.json';
import { classifyDocxMessages } from '../src/lib/docxMessages';
import { sanitizeDocxHtml } from '../src/lib/docxSanitizer';
import { convertDocxArrayBuffer } from '../src/lib/docxWorkerConversion';

const fixtureRoot = path.resolve('test-fixtures/p2/docx');
const upstreamFixtureRoot = path.resolve('node_modules/mammoth/test/test-data');

function copyToOwnedArrayBuffer(value) {
  let bytes;
  if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value);
  } else if (ArrayBuffer.isView(value)) {
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else {
    throw new TypeError('Mammoth returned invalid embedded image bytes');
  }

  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

const nodeTestMammothApi = {
  convertToHtml({ arrayBuffer }, options) {
    return mammoth.convertToHtml({ buffer: Buffer.from(arrayBuffer) }, options);
  },
  images: {
    imgElement(callback) {
      return mammoth.images.imgElement((image) => callback({
        contentType: image.contentType,
        readAsArrayBuffer: () => new Promise((resolve, reject) => {
          image.readAsArrayBuffer().then(resolve, reject);
        }),
      }));
    },
  },
};

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function fixtureBytes(name) {
  const bytes = await readFile(path.join(fixtureRoot, name));
  return copyToOwnedArrayBuffer(bytes);
}

async function convertFixture(name) {
  return convertDocxArrayBuffer(await fixtureBytes(name), { mammothApi: nodeTestMammothApi });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('real pinned DOCX fixture integration', () => {
  it('locks every repo-owned fixture to the exact Mammoth 1.12.0 bytes', async () => {
    expect(packageManifest.dependencies.mammoth).toBe('1.12.0');
    expect(fixtureManifest.source).toBe('mammoth@1.12.0/test/test-data');
    expect(fixtureManifest.files.map(({ name }) => name)).toEqual([
      'empty.docx',
      'external-picture.docx',
      'single-paragraph.docx',
      'tables.docx',
      'text-box.docx',
      'tiny-picture.docx',
    ]);

    for (const fixture of fixtureManifest.files) {
      const [repoBytes, upstreamBytes] = await Promise.all([
        readFile(path.join(fixtureRoot, fixture.name)),
        readFile(path.join(upstreamFixtureRoot, fixture.name)),
      ]);
      expect(repoBytes.byteLength).toBe(fixture.bytes);
      expect(sha256(repoBytes)).toBe(fixture.sha256);
      expect(repoBytes).toEqual(upstreamBytes);
    }
  });

  it('converts and sanitizes real supported paragraph, table, textbox, and image documents', async () => {
    const paragraph = await convertFixture('single-paragraph.docx');
    const paragraphPolicy = classifyDocxMessages(paragraph.messages);
    const paragraphOutput = sanitizeDocxHtml(paragraph.rawHtml, paragraph.images);
    expect(paragraphPolicy).toEqual({ fatal: false, detectedLoss: false });
    expect(paragraphOutput.html).toBe('<p>Walking on imported air</p>');

    const table = await convertFixture('tables.docx');
    const tablePolicy = classifyDocxMessages(table.messages);
    const tableOutput = sanitizeDocxHtml(table.rawHtml, table.images);
    expect(tablePolicy).toEqual({ fatal: false, detectedLoss: false });
    expect(tableOutput.html).toContain('<table>');
    expect(tableOutput.html).toContain('<td><p>Top left</p></td>');

    const textBox = await convertFixture('text-box.docx');
    const textBoxPolicy = classifyDocxMessages(textBox.messages);
    const textBoxOutput = sanitizeDocxHtml(textBox.rawHtml, textBox.images);
    expect(textBoxPolicy).toEqual({ fatal: false, detectedLoss: false });
    expect(textBoxOutput.html).toBe('<p>Datum plane</p>');

    const image = await convertFixture('tiny-picture.docx');
    const imagePolicy = classifyDocxMessages(image.messages);
    const imageOutput = sanitizeDocxHtml(image.rawHtml, image.images);
    expect(imagePolicy).toEqual({ fatal: false, detectedLoss: false });
    expect(image.images).toHaveLength(1);
    expect(imageOutput.html).toMatch(/<img src="data:image\/png;base64,[A-Za-z0-9+/]+=*">/);
    expect(imageOutput.html).not.toContain('.invalid/image/');
  });

  it('treats real empty, corrupt, and blocked external-image documents as total failures', async () => {
    const fetchSpy = vi.fn();
    let xhrConstructions = 0;
    class ForbiddenXMLHttpRequest {
      constructor() {
        xhrConstructions += 1;
      }
    }
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('XMLHttpRequest', ForbiddenXMLHttpRequest);
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

    const empty = await convertFixture('empty.docx');
    expect(classifyDocxMessages(empty.messages)).toEqual({ fatal: false, detectedLoss: false });
    expect(() => sanitizeDocxHtml(empty.rawHtml, empty.images))
      .toThrow('The DOCX did not contain a usable preview.');

    await expect(convertDocxArrayBuffer(
      new Uint8Array([0x50, 0x4b, 0x00, 0x01]).buffer,
      { mammothApi: nodeTestMammothApi },
    )).rejects.toThrow("Can't find end of central directory");

    const external = await convertFixture('external-picture.docx');
    expect(classifyDocxMessages(external.messages)).toEqual({ fatal: true, detectedLoss: false });
    expect(external.images).toHaveLength(0);
    expect(() => sanitizeDocxHtml(external.rawHtml, external.images))
      .toThrow('The DOCX did not contain a usable preview.');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhrConstructions).toBe(0);
    expect(openSpy).not.toHaveBeenCalled();
  });
});
