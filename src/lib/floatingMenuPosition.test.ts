import { describe, expect, it } from 'vitest';
import { getFloatingMenuPosition } from './floatingMenuPosition';

describe('floating menu positioning', () => {
  it('keeps a pointer-anchored menu at the pointer when it fits in the viewport', () => {
    expect(getFloatingMenuPosition({
      anchor: { x: 180, y: 240 },
      menu: { height: 132, width: 204 },
      viewport: { height: 720, width: 960 },
    })).toEqual({ x: 180, y: 240 });
  });

  it('moves a menu only far enough to preserve the viewport margin', () => {
    expect(getFloatingMenuPosition({
      anchor: { x: 910, y: 690 },
      menu: { height: 132, width: 204 },
      viewport: { height: 720, width: 960 },
    })).toEqual({ x: 748, y: 580 });
  });

  it('supports end-aligned trigger menus without hard-coded menu widths', () => {
    expect(getFloatingMenuPosition({
      align: 'end',
      anchor: { x: 256, y: 84 },
      menu: { height: 112, width: 204 },
      viewport: { height: 720, width: 960 },
    })).toEqual({ x: 52, y: 84 });
  });
});
