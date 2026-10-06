// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewPane } from './PreviewPane';

describe('PreviewPane', () => {
  let container: HTMLDivElement;
  let root: Root;
  let scrollIntoView = vi.fn<() => void>();
  let originalScrollIntoView: PropertyDescriptor | undefined;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    scrollIntoView = vi.fn<() => void>();
    originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    if (originalScrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView);
    } else {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it('scrolls the matching rendered heading for an outline selection', () => {
    act(() => {
      root.render(
        <PreviewPane
          dirty={false}
          outlineJump={{
            documentId: 'document-guide',
            documentEpoch: 1,
            item: {
              depth: 1,
              id: 'heading-11',
              level: 2,
              line: 3,
              offset: 11,
              ordinal: 1,
              text: 'Install',
            },
            requestId: 1,
          }}
        >
          <article>
            <h1 data-heading-line="1">Project</h1>
            <h2 data-heading-line="3">Install</h2>
          </article>
        </PreviewPane>,
      );
    });

    const installHeading = container.querySelector('h2');
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
    expect(scrollIntoView.mock.instances[0]).toBe(installHeading);
  });

  it('waits for a deferred preview heading before scrolling', async () => {
    const outlineJump = {
      documentId: 'document-guide',
      documentEpoch: 1,
      item: {
        depth: 1,
        id: 'heading-11',
        level: 2,
        line: 3,
        offset: 11,
        ordinal: 1,
        text: 'Install',
      },
      requestId: 2,
    };

    act(() => {
      root.render(
        <PreviewPane dirty={false} outlineJump={outlineJump}>
          <article><h1 data-heading-line="1">Project</h1></article>
        </PreviewPane>,
      );
    });
    expect(scrollIntoView).not.toHaveBeenCalled();

    await act(async () => {
      root.render(
        <PreviewPane dirty={false} outlineJump={outlineJump}>
          <article><h1 data-heading-line="1">Project</h1><h2 data-heading-line="3">Install</h2></article>
        </PreviewPane>,
      );
      await Promise.resolve();
    });

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
    expect(scrollIntoView.mock.instances[0]).toBe(container.querySelector('h2'));
  });

  it('uses the source line when rendered title text differs from the outline label', () => {
    act(() => {
      root.render(
        <PreviewPane
          dirty={false}
          outlineJump={{
            documentId: 'document-guide',
            documentEpoch: 1,
            item: {
              depth: 1,
              id: 'heading-11',
              level: 2,
              line: 3,
              offset: 11,
              ordinal: 1,
              text: '\\*literal\\*',
            },
            requestId: 3,
          }}
        >
          <article>
            <h1 data-heading-line="1">Project</h1>
            <h2 data-heading-line="3">*literal*</h2>
          </article>
        </PreviewPane>,
      );
    });

    expect(scrollIntoView.mock.instances[0]).toBe(container.querySelector('h2'));
  });
});
