type ExcalidrawFontFamily =
  | 'Cascadia'
  | 'Comic Shanns'
  | 'Excalifont'
  | 'Helvetica'
  | 'Liberation Sans'
  | 'Lilita One'
  | 'Nunito'
  | 'Virgil'
  | 'Xiaolai'
  | 'Segoe UI Emoji';

type FontFaceEnvironment = {
  FontFace?: typeof FontFace;
};

const ADAPTER_MARKER = Symbol.for('mmd.excalidrawSystemFonts.installed');

export const EXCALIDRAW_SYSTEM_FONT_SOURCES = Object.freeze({
  Cascadia: 'local("Consolas"), local("Menlo"), local("DejaVu Sans Mono")',
  'Comic Shanns': 'local("Comic Sans MS"), local("Chalkboard SE"), local("DejaVu Sans")',
  Excalifont: 'local("Comic Sans MS"), local("Chalkboard SE"), local("DejaVu Sans")',
  Helvetica: 'local("Arial"), local("Helvetica"), local("Liberation Sans")',
  'Liberation Sans': 'local("Arial"), local("Helvetica"), local("Liberation Sans")',
  'Lilita One': 'local("Arial Black"), local("Avenir Next Condensed"), local("DejaVu Sans")',
  Nunito: 'local("Segoe UI"), local("Helvetica Neue"), local("Ubuntu")',
  Virgil: 'local("Comic Sans MS"), local("Chalkboard SE"), local("DejaVu Sans")',
  Xiaolai: 'local("Microsoft YaHei"), local("PingFang SC"), local("Noto Sans CJK SC")',
  'Segoe UI Emoji': 'local("Segoe UI Emoji"), local("Apple Color Emoji"), local("Noto Color Emoji")',
} satisfies Record<ExcalidrawFontFamily, string>);

function replacementSource(family: string, source: string | BufferSource) {
  if (typeof source !== 'string' || (source.trim() !== '' && !/\burl\s*\(/iu.test(source))) {
    return source;
  }

  return EXCALIDRAW_SYSTEM_FONT_SOURCES[family as ExcalidrawFontFamily] ?? source;
}

export function installExcalidrawSystemFonts(
  environment: FontFaceEnvironment = globalThis as FontFaceEnvironment,
): void {
  const NativeFontFace = environment.FontFace;
  if (typeof NativeFontFace !== 'function') return;

  const markedConstructor = NativeFontFace as unknown as Record<PropertyKey, unknown>;
  if (markedConstructor[ADAPTER_MARKER] === true) return;

  const SystemFontFace = new Proxy(NativeFontFace, {
    construct(target, args, newTarget) {
      const [family, source, descriptors] = args;
      return Reflect.construct(
        target,
        [family, replacementSource(family, source), descriptors],
        newTarget,
      );
    },
    get(target, property, receiver) {
      if (property === ADAPTER_MARKER) return true;
      return Reflect.get(target, property, receiver);
    },
  });

  try {
    environment.FontFace = SystemFontFace;
  } catch {
    // Some WebViews expose FontFace as a read-only host property.
  }
}
