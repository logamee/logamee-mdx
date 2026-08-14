/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MMD_PACKAGED_LIFECYCLE_E2E?: string;
  readonly VITE_MMD_PACKAGED_OPEN_E2E?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module 'react-syntax-highlighter/dist/esm/languages/prism/supported-languages' {
  const supportedLanguages: string[];
  export default supportedLanguages;
}
