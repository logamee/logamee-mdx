import { describe, expect, it } from 'vitest';
import {
  clampEditorPaneRatio,
  getPaneLayoutStyle,
  getPanePopoutButtonState,
  getPanePopoutLabel,
  getPanePopoutUrl,
  parsePopoutInstanceId,
  parsePopoutPane,
  resizeEditorPaneRatio,
  resizeEditorPaneRatioFromKey,
} from './paneLayout';

describe('editor and preview pane layout', () => {
  it('clamps editor width ratio so both panes remain usable', () => {
    expect(clampEditorPaneRatio(0.1)).toBe(0.25);
    expect(clampEditorPaneRatio(0.5)).toBe(0.5);
    expect(clampEditorPaneRatio(0.9)).toBe(0.75);
  });

  it('converts horizontal drag distance into a clamped editor ratio', () => {
    expect(resizeEditorPaneRatio({ startRatio: 0.5, deltaX: 120, containerWidth: 1200 })).toBeCloseTo(0.6);
    expect(resizeEditorPaneRatio({ startRatio: 0.5, deltaX: -600, containerWidth: 1200 })).toBe(0.25);
    expect(resizeEditorPaneRatio({ startRatio: 0.5, deltaX: 600, containerWidth: 1200 })).toBe(0.75);
  });

  it('adjusts the editor split from the keyboard and restores an even split', () => {
    expect(resizeEditorPaneRatioFromKey(0.5, 'ArrowLeft', false)).toBeCloseTo(0.48);
    expect(resizeEditorPaneRatioFromKey(0.5, 'ArrowRight', false)).toBeCloseTo(0.52);
    expect(resizeEditorPaneRatioFromKey(0.5, 'ArrowRight', true)).toBeCloseTo(0.58);
    expect(resizeEditorPaneRatioFromKey(0.64, 'Home', false)).toBe(0.5);
    expect(resizeEditorPaneRatioFromKey(0.5, 'ArrowUp', false)).toBeNull();
    expect(resizeEditorPaneRatioFromKey(0.25, 'ArrowLeft', false)).toBe(0.25);
  });

  it('returns CSS variables for the editor and preview split', () => {
    expect(getPaneLayoutStyle(0.4)).toEqual({
      '--editor-pane-ratio': '40%',
      '--preview-pane-ratio': '60%',
      '--editor-pane-fr': '0.4fr',
      '--preview-pane-fr': '0.6fr',
    });
  });

  it('parses and builds popout pane URLs', () => {
    expect(parsePopoutPane('?pane=editor')).toBe('editor');
    expect(parsePopoutPane('?pane=preview')).toBe('preview');
    expect(parsePopoutPane('?pane=other')).toBe('main');
    expect(getPanePopoutLabel('editor')).toBe('mmd-editor-popout');
    expect(getPanePopoutUrl('preview')).toBe('/?pane=preview');
  });

  it('builds and parses validated editor popout instance IDs', () => {
    expect(getPanePopoutUrl('editor', 'editor:1/2')).toBe('/?pane=editor');
    expect(getPanePopoutUrl('editor', 'editor:1.2')).toBe('/?pane=editor&instance=editor%3A1.2');
    expect(getPanePopoutUrl('preview', 'editor:1.2')).toBe('/?pane=preview');
    expect(parsePopoutInstanceId('?instance=editor%3A1.2')).toBe('editor:1.2');
    expect(parsePopoutInstanceId('?instance=')).toBeNull();
    expect(parsePopoutInstanceId('?instance=editor%2F1')).toBeNull();
    expect(parsePopoutInstanceId(`?instance=${'a'.repeat(129)}`)).toBeNull();
  });

  it('labels popout buttons differently when the pane is already popped out', () => {
    expect(getPanePopoutButtonState('editor', false)).toEqual({
      ariaLabel: 'Pop out editor',
      title: 'Pop out editor',
      statusLabel: null,
      isPoppedOut: false,
    });
    expect(getPanePopoutButtonState('preview', true)).toEqual({
      ariaLabel: 'Live Preview is open in a separate window; click to focus it',
      title: 'Live Preview is open in a separate window; click to focus it',
      statusLabel: 'Popped out',
      isPoppedOut: true,
    });
  });
});
