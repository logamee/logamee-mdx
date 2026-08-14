// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { getMediaPlaybackMode, WorkspaceMediaPreview } from './WorkspaceMediaPreview';

interface MockMpegtsPlayer {
  attachMediaElement: (mediaElement: HTMLMediaElement) => void;
  destroy: () => void;
  detachMediaElement: () => void;
  load: () => void;
  off: (event: string, listener: (...args: unknown[]) => void) => void;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  unload: () => void;
}

const commandMocks = vi.hoisted(() => ({
  resolveWorkspaceMedia: vi.fn<(path: string) => Promise<string>>(),
}));
const mpegtsMocks = vi.hoisted(() => ({
  Events: { ERROR: 'error', MEDIA_INFO: 'media-info' },
  createPlayer: vi.fn<(options: { url: string }) => MockMpegtsPlayer>(),
  isSupported: vi.fn<() => boolean>(() => true),
}));

vi.mock('../lib/tauriCommands', () => ({
  resolveWorkspaceMedia: commandMocks.resolveWorkspaceMedia,
}));

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
  invoke: vi.fn<typeof import('@tauri-apps/api/core').invoke>(),
}));
vi.mock('mpegts.js', () => ({ default: mpegtsMocks }));

describe('WorkspaceMediaPreview', () => {
  it('routes FLV through the dedicated player and browser formats through native playback', () => {
    expect(getMediaPlaybackMode('/workspace/clip.flv')).toBe('flv');
    expect(getMediaPlaybackMode('/workspace/CLIP.FLV')).toBe('flv');
    expect(getMediaPlaybackMode('/workspace/clip.mp4')).toBe('native');
    expect(getMediaPlaybackMode('/workspace/song.mp3')).toBe('native');
  });

  it('shows an accessible loading state for selected media', () => {
    const html = renderToStaticMarkup(
      <WorkspaceMediaPreview kind="video" mimeType="video/mp4" path="/workspace/media/clip.mp4" previewRevision={0} />,
    );

    expect(html).toContain('Media Preview');
    expect(html).toContain('clip.mp4');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Loading media');
  });

  it('does not create a media element before document authority is committed', () => {
    const html = renderToStaticMarkup(
      <WorkspaceMediaPreview
        enabled={false}
        kind="video"
        mimeType="video/mp4"
        path="/workspace/media/clip.mp4"
        previewRevision={0}
      />,
    );

    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('<video');
    expect(html).not.toContain('asset://');
  });

  it('reloads native media when the same path receives a newer preview revision', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    commandMocks.resolveWorkspaceMedia.mockReset();
    commandMocks.resolveWorkspaceMedia.mockResolvedValue('/workspace/media/clip.mp4');
    const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => root.render(
        <WorkspaceMediaPreview
          kind="video"
          mimeType="video/mp4"
          path="/workspace/media/clip.mp4"
          previewRevision={1}
        />,
      ));
      const firstVideo = container.querySelector<HTMLVideoElement>('video');
      expect(firstVideo?.src).toContain('mmdRevision=1');
      act(() => firstVideo?.dispatchEvent(new Event('loadedmetadata')));
      expect(container.querySelector('.workspace-media-viewport')?.getAttribute('aria-busy')).toBe('false');
      const initialLoadCalls = load.mock.calls.length;

      await act(async () => root.render(
        <WorkspaceMediaPreview
          kind="video"
          mimeType="video/mp4"
          path="/workspace/media/clip.mp4"
          previewRevision={2}
        />,
      ));

      expect(commandMocks.resolveWorkspaceMedia).toHaveBeenCalledTimes(2);
      expect(container.querySelector<HTMLVideoElement>('video')?.src).toContain('mmdRevision=2');
      expect(container.querySelector('.workspace-media-viewport')?.getAttribute('aria-busy')).toBe('true');
      expect(load.mock.calls.length).toBeGreaterThan(initialLoadCalls);
    } finally {
      act(() => root.unmount());
      container.remove();
      load.mockRestore();
    }
  });

  it('tears down the old FLV player before creating one for a newer preview revision', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    commandMocks.resolveWorkspaceMedia.mockReset();
    commandMocks.resolveWorkspaceMedia.mockResolvedValue('/workspace/media/clip.flv');
    mpegtsMocks.createPlayer.mockReset();
    mpegtsMocks.isSupported.mockReset();
    mpegtsMocks.isSupported.mockReturnValue(true);
    const lifecycle: string[] = [];
    let playerSequence = 0;
    mpegtsMocks.createPlayer.mockImplementation((options: { url: string }) => {
      playerSequence += 1;
      const playerId = `player-${playerSequence}`;
      lifecycle.push(`${playerId}:create:${options.url}`);
      return {
        attachMediaElement: vi.fn<(mediaElement: HTMLMediaElement) => void>(() => {
          lifecycle.push(`${playerId}:attach`);
        }),
        destroy: vi.fn<() => void>(() => {
          lifecycle.push(`${playerId}:destroy`);
        }),
        detachMediaElement: vi.fn<() => void>(() => {
          lifecycle.push(`${playerId}:detach`);
        }),
        load: vi.fn<() => void>(() => {
          lifecycle.push(`${playerId}:load`);
        }),
        off: vi.fn<(event: string, listener: (...args: unknown[]) => void) => void>(),
        on: vi.fn<(event: string, listener: (...args: unknown[]) => void) => void>(),
        unload: vi.fn<() => void>(() => {
          lifecycle.push(`${playerId}:unload`);
        }),
      };
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => root.render(
        <WorkspaceMediaPreview
          kind="video"
          mimeType="video/x-flv"
          path="/workspace/media/clip.flv"
          previewRevision={1}
        />,
      ));
      await act(async () => Promise.resolve());
      expect(mpegtsMocks.createPlayer).toHaveBeenCalledOnce();

      await act(async () => root.render(
        <WorkspaceMediaPreview
          kind="video"
          mimeType="video/x-flv"
          path="/workspace/media/clip.flv"
          previewRevision={2}
        />,
      ));
      await act(async () => Promise.resolve());

      expect(mpegtsMocks.createPlayer).toHaveBeenCalledTimes(2);
      const secondCreateIndex = lifecycle.findIndex((entry) => entry.startsWith('player-2:create:'));
      expect(lifecycle.indexOf('player-1:unload')).toBeGreaterThanOrEqual(0);
      expect(lifecycle.indexOf('player-1:detach')).toBeGreaterThan(lifecycle.indexOf('player-1:unload'));
      expect(lifecycle.indexOf('player-1:destroy')).toBeGreaterThan(lifecycle.indexOf('player-1:detach'));
      expect(secondCreateIndex).toBeGreaterThan(lifecycle.indexOf('player-1:destroy'));
      expect(lifecycle[secondCreateIndex]).toContain('mmdRevision=2');
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
