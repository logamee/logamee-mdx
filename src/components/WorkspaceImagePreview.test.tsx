// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { vi } from 'vitest';
import { WorkspaceImagePreview } from './WorkspaceImagePreview';

const commandMocks = vi.hoisted(() => ({
  readWorkspaceImage: vi.fn<(path: string) => Promise<string>>(),
}));

vi.mock('../lib/tauriCommands', () => ({
  readWorkspaceImage: commandMocks.readWorkspaceImage,
}));

describe('WorkspaceImagePreview', () => {
  it('shows an accessible loading state for the selected image', () => {
    const html = renderToStaticMarkup(
      <WorkspaceImagePreview path="/workspace/assets/cover.png" previewRevision={0} />,
    );

    expect(html).toContain('Image Preview');
    expect(html).toContain('cover.png');
    expect(html).toContain('<output class="workspace-image-status"');
    expect(html).toContain('Loading image');
  });

  it('does not expose image data before document authority is committed', () => {
    const html = renderToStaticMarkup(
      <WorkspaceImagePreview enabled={false} path="/workspace/assets/cover.png" previewRevision={0} />,
    );

    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('<img');
  });

  it('loads image data through the authorized command and reloads it when its preview revision changes', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    commandMocks.readWorkspaceImage.mockReset();
    commandMocks.readWorkspaceImage.mockResolvedValue('data:image/png;base64,iVBORw==');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => root.render(
        <WorkspaceImagePreview path="/workspace/assets/cover.png" previewRevision={1} />,
      ));
      const firstImage = container.querySelector<HTMLImageElement>('img');
      expect(commandMocks.readWorkspaceImage).toHaveBeenCalledWith('/workspace/assets/cover.png');
      expect(firstImage?.src).toBe('data:image/png;base64,iVBORw==');
      expect(firstImage?.src).not.toContain('/workspace/assets/cover.png');
      act(() => firstImage?.dispatchEvent(new Event('load')));
      expect(container.querySelector('.workspace-image-viewport')?.getAttribute('aria-busy')).toBe('false');

      await act(async () => root.render(
        <WorkspaceImagePreview path="/workspace/assets/cover.png" previewRevision={2} />,
      ));

      expect(commandMocks.readWorkspaceImage).toHaveBeenCalledTimes(2);
      expect(container.querySelector<HTMLImageElement>('img')?.src).toBe('data:image/png;base64,iVBORw==');
      expect(container.querySelector('.workspace-image-viewport')?.getAttribute('aria-busy')).toBe('true');
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('reports a display-specific error when browser decoding fails', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    commandMocks.readWorkspaceImage.mockReset();
    commandMocks.readWorkspaceImage.mockResolvedValue('data:image/png;base64,iVBORw==');
    const feedback = vi.fn<(event: Event) => void>();
    window.addEventListener('mmd:app-feedback-error', feedback);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => root.render(
        <WorkspaceImagePreview path="/workspace/assets/cover.png" previewRevision={4} />,
      ));
      act(() => container.querySelector('img')?.dispatchEvent(new Event('error')));

      expect(container.querySelector('.workspace-image-error')?.textContent).toBe('Image could not be loaded.');
      expect(feedback).toHaveBeenCalledOnce();
      const event = feedback.mock.calls[0][0];
      expect(event).toBeInstanceOf(CustomEvent);
      expect((event as CustomEvent<string>).detail).toBe(
        'Image preview could not be displayed',
      );
    } finally {
      window.removeEventListener('mmd:app-feedback-error', feedback);
      act(() => root.unmount());
      container.remove();
    }
  });
});
