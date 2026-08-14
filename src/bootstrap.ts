import './lib/excalidrawSystemFontsBootstrap';

if (
  import.meta.env.VITE_MMD_PACKAGED_LIFECYCLE_E2E === '1'
  || import.meta.env.VITE_MMD_PACKAGED_OPEN_E2E === '1'
) {
  void import('./lib/packagedBootstrap').then(({ startPackagedBootstrap }) => (
    startPackagedBootstrap()
  ));
} else {
  void import('./main');
}
