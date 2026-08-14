export const FLOATING_MENU_VIEWPORT_MARGIN = 8;

interface Point {
  x: number;
  y: number;
}

interface Size {
  height: number;
  width: number;
}

interface FloatingMenuPositionInput {
  align?: 'end' | 'start';
  anchor: Point;
  margin?: number;
  menu: Size;
  viewport: Size;
}

export function getFloatingMenuPosition({
  align = 'start',
  anchor,
  margin = FLOATING_MENU_VIEWPORT_MARGIN,
  menu,
  viewport,
}: FloatingMenuPositionInput): Point {
  const desiredX = align === 'end' ? anchor.x - menu.width : anchor.x;
  const maxX = Math.max(margin, viewport.width - menu.width - margin);
  const maxY = Math.max(margin, viewport.height - menu.height - margin);

  return {
    x: Math.round(Math.max(margin, Math.min(desiredX, maxX))),
    y: Math.round(Math.max(margin, Math.min(anchor.y, maxY))),
  };
}
