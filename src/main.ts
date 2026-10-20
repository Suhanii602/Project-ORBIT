// Chooses the renderer: Cesium on desktop, three-globe on touch screens.
// Add ?mode=mobile or ?mode=desktop to the URL to force one.
const forced = new URLSearchParams(location.search).get('mode');
const useMobile = forced
  ? forced === 'mobile'
  : window.matchMedia('(pointer: coarse) and (max-width: 900px)').matches;

if (useMobile) {
  import('./mobile');
} else {
  import('./desktop');
}