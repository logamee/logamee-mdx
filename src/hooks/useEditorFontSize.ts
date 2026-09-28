import { useCallback, useMemo, useRef } from 'react';
import type { AppSettings } from '../types';
import { DEFAULT_EDITOR_FONT_SIZE, stepEditorFontSize } from '../lib/settings';

export interface EditorFontSizeController {
  fontSize: number;
  increase: () => void;
  decrease: () => void;
  reset: () => void;
}

// 编辑器字号会被快捷键连按高频调整。设置写入基于 revision 做乐观并发控制，
// 并发 update 会携带过期 revision 触发冲突恢复弹窗，所以这里只串行发起写入：
// 目标字号先登记，同一时刻最多一个写入在飞，完成后再冲刷剩余目标（此时设置
// 已携带新 revision 重渲染）。
export function useEditorFontSize(
  settings: AppSettings | null,
  updateSettings: (settings: AppSettings) => Promise<void>,
): EditorFontSizeController {
  const settingsRef = useRef<AppSettings | null>(settings);
  settingsRef.current = settings;
  const updateSettingsRef = useRef(updateSettings);
  updateSettingsRef.current = updateSettings;
  const targetRef = useRef<number | null>(null);
  const inFlightRef = useRef(false);

  const flush = useCallback(async () => {
    if (inFlightRef.current) return;
    const target = targetRef.current;
    const current = settingsRef.current;
    if (target === null) return;
    if (!current || current.editorFontSize === target) {
      targetRef.current = null;
      return;
    }
    inFlightRef.current = true;
    let wrote = false;
    try {
      await updateSettingsRef.current({ ...current, editorFontSize: target });
      wrote = true;
    } catch {
      wrote = false;
    } finally {
      inFlightRef.current = false;
    }
    if (!wrote) {
      // 写入异常由 useSettings 统一进入恢复模型；丢弃目标避免反复重试。
      targetRef.current = null;
      return;
    }
    globalThis.setTimeout(() => {
      if (settingsRef.current === current) {
        // 写入完成后设置未随之推进（被恢复模型拦截或落空）：丢弃目标，避免无限重写。
        targetRef.current = null;
        return;
      }
      void flush();
    }, 0);
  }, []);

  const request = useCallback((next: number) => {
    targetRef.current = next;
    void flush();
  }, [flush]);

  const increase = useCallback(() => {
    const base = targetRef.current ?? settingsRef.current?.editorFontSize;
    if (base === undefined) return;
    request(stepEditorFontSize(base, 1));
  }, [request]);

  const decrease = useCallback(() => {
    const base = targetRef.current ?? settingsRef.current?.editorFontSize;
    if (base === undefined) return;
    request(stepEditorFontSize(base, -1));
  }, [request]);

  const reset = useCallback(() => {
    if (!settingsRef.current) return;
    request(DEFAULT_EDITOR_FONT_SIZE);
  }, [request]);

  const fontSize = settings && Number.isFinite(settings.editorFontSize)
    ? settings.editorFontSize
    : DEFAULT_EDITOR_FONT_SIZE;

  return useMemo(() => ({ fontSize, increase, decrease, reset }), [fontSize, increase, decrease, reset]);
}
