import type { SkinDefinition } from "../skinTypes";

export const originalSkin = {
  id: "original",
  nameZh: "素笺·青黛",
  nameEn: "Plain Paper · Indigo",
  appearance: "adaptive",
  tokens: null,
  swatches: {
    light: ["#ffffff", "#333333", "#264783", "#e5e5e5"],
    dark: ["#0f172a", "#a1a1aa", "#8eb0e0", "#1e293b"],
  },
} as const satisfies SkinDefinition;
