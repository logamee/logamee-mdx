const IME_COMPOSITION_KEY_CODE = 229;

export function isImeCompositionKey(event: Pick<KeyboardEvent, 'isComposing' | 'keyCode'>): boolean {
  return event.isComposing || event.keyCode === IME_COMPOSITION_KEY_CODE;
}

export function isImeCompositionEscape(event: Pick<KeyboardEvent, 'isComposing' | 'key' | 'keyCode'>): boolean {
  return event.key === 'Escape' && isImeCompositionKey(event);
}
