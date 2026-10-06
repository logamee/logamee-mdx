import type { SkinDefinition } from "./skinTypes";
import { originalSkin } from "./skins/originalSkin";
import { jinxiuZhushaSkin } from "./skins/jinxiuZhushaSkin";
import { ruyaoTianqingSkin } from "./skins/ruyaoTianqingSkin";
import { qinghuaJilanSkin } from "./skins/qinghuaJilanSkin";
import { songkeZhuyingSkin } from "./skins/songkeZhuyingSkin";
import { gujuanNuanxingSkin } from "./skins/gujuanNuanxingSkin";
import { zhuyingQingciSkin } from "./skins/zhuyingQingciSkin";
import { jiushuHuangzhiSkin } from "./skins/jiushuHuangzhiSkin";
import { shanshuiYemoSkin } from "./skins/shanshuiYemoSkin";

export const SKINS = [
  originalSkin,
  jinxiuZhushaSkin,
  ruyaoTianqingSkin,
  qinghuaJilanSkin,
  songkeZhuyingSkin,
  gujuanNuanxingSkin,
  zhuyingQingciSkin,
  jiushuHuangzhiSkin,
  shanshuiYemoSkin,
] as const satisfies readonly SkinDefinition[];

export type SkinId = (typeof SKINS)[number]["id"];
export const SKIN_IDS: readonly SkinId[] = SKINS.map(({ id }) => id);

export function isSkinId(value: unknown): value is SkinId {
  return (
    typeof value === "string" && (SKIN_IDS as readonly string[]).includes(value)
  );
}
