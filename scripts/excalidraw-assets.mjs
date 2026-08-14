import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXCALIDRAW_VERSION = '0.18.1';
export const EXCALIDRAW_FONT_FAMILIES = Object.freeze([
  'Cascadia',
  'Comic Shanns',
  'Excalifont',
  'Helvetica',
  'Liberation Sans',
  'Lilita One',
  'Nunito',
  'Virgil',
  'Xiaolai',
  'Segoe UI Emoji',
]);

const projectRootFromModule = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

const SHAPES = {
  development: {
    familyMarker: '      return `${fontFamilyString}${getFontFamilyFallbacks(id).map((x) => `, ${x}`).join("")}`;',
    familyReplacement: '      return `${fontFamilyString}${getFontFamilyFallbacks(id).map((x) => `, ${x}`).join("")}, ${id === FONT_FAMILY.Cascadia || id === FONT_FAMILY["Comic Shanns"] ? "ui-monospace, monospace" : "system-ui, sans-serif"}`;',
    modulePath: 'dist/dev/chunk-4FTI6OG3.js',
    registrationMarker: `    init("Cascadia", ...CascadiaFontFaces);
    init("Comic Shanns", ...ComicShannsFontFaces);
    init("Excalifont", ...ExcalifontFontFaces);
    init("Helvetica", ...HelveticaFontFaces);
    init("Liberation Sans", ...LiberationFontFaces);
    init("Lilita One", ...LilitaFontFaces);
    init("Nunito", ...NunitoFontFaces);
    init("Virgil", ...VirgilFontFaces);
    init(CJK_HAND_DRAWN_FALLBACK_FONT, ...XiaolaiFontFaces);
    init(WINDOWS_EMOJI_FALLBACK_FONT, ...EmojiFontFaces);`,
    svgMarker: '  const fontFaces = !opts?.skipInliningFonts ? await Fonts.generateFontFaceDeclarations(elements) : [];',
    svgReplacement: '  const fontFaces = [];',
  },
  production: {
    familyMarker: 'ea=({fontFamily:e})=>{for(let[t,n]of Object.entries(Ie))if(n===e)return`${t}${bo(n).map(r=>`, ${r}`).join("")}`;return Tn}',
    familyReplacement: 'ea=({fontFamily:e})=>{for(let[t,n]of Object.entries(Ie))if(n===e)return`${t}${bo(n).map(r=>`, ${r}`).join("")}, ${n===Ie.Cascadia||n===Ie["Comic Shanns"]?"ui-monospace, monospace":"system-ui, sans-serif"}`;return`${Tn}, system-ui, sans-serif`}',
    modulePath: 'dist/prod/chunk-K2UTITRG.js',
    registrationMarker: 'static init(){let t={registered:new Map},n=(r,...o)=>{let i=Ie[r]??Un[r],a=Fr[i]??Fr[Ie.Excalifont];ne.register.call(t,r,a,...o)};return n("Cascadia",...Gd),n("Comic Shanns",...Qd),n("Excalifont",...sc),n("Helvetica",...dc),n("Liberation Sans",...lc),n("Lilita One",...pc),n("Nunito",...xc),n("Virgil",...yc),n(Mn,...b1),n(Tn,...jd),ne._initialized=!0,t.registered}',
    svgMarker: 'let S=r?.skipInliningFonts?[]:await Nn.generateFontFaceDeclarations(e),v=',
    svgReplacement: 'let S=[],v=',
  },
};

function countOccurrences(source, marker) {
  return source.split(marker).length - 1;
}

function assertExactlyOne(source, marker, label, shape) {
  const count = countOccurrences(source, marker);
  if (count !== 1) {
    throw new Error(`Excalidraw ${shape} expected exactly 1 ${label}, found ${count}`);
  }
}

function shapeForId(id) {
  const normalizedId = id.split('?')[0].replaceAll('\\', '/');
  return Object.entries(SHAPES).find(([, shape]) => normalizedId.endsWith(
    `/node_modules/@excalidraw/excalidraw/${shape.modulePath}`,
  )) ?? null;
}

export function assertExcalidrawVersion(actualVersion) {
  if (actualVersion !== EXCALIDRAW_VERSION) {
    throw new Error(`Expected @excalidraw/excalidraw ${EXCALIDRAW_VERSION}, found ${String(actualVersion)}`);
  }
}

export function transformExcalidrawModule(code, id) {
  const entry = shapeForId(id);
  if (!entry) return null;

  const [shapeName, shape] = entry;
  assertExactlyOne(code, shape.registrationMarker, 'registered-family marker', shapeName);
  assertExactlyOne(code, shape.familyMarker, 'font-family marker', shapeName);
  assertExactlyOne(code, shape.svgMarker, 'SVG font-inlining marker', shapeName);

  return {
    code: code
      .replace(shape.familyMarker, shape.familyReplacement)
      .replace(shape.svgMarker, shape.svgReplacement),
    map: null,
  };
}

export async function validatePinnedExcalidrawBuild({
  projectRoot = projectRootFromModule,
} = {}) {
  const packageRoot = path.join(projectRoot, 'node_modules', '@excalidraw', 'excalidraw');
  const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  assertExcalidrawVersion(packageJson.version);

  const validatedPaths = {};
  for (const [shapeName, shape] of Object.entries(SHAPES)) {
    const modulePath = path.join(packageRoot, shape.modulePath);
    const source = await readFile(modulePath, 'utf8');
    transformExcalidrawModule(source, modulePath);
    validatedPaths[shapeName] = modulePath;
  }
  return validatedPaths;
}

export function createExcalidrawFontTransformPlugin({
  projectRoot = projectRootFromModule,
} = {}) {
  return {
    name: 'mmd-excalidraw-system-fonts',
    enforce: 'pre',
    async buildStart() {
      await validatePinnedExcalidrawBuild({ projectRoot });
    },
    transform(code, id) {
      return transformExcalidrawModule(code, id);
    },
  };
}
