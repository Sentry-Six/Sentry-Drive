// MapLibre GL is published only as an ES module. Expose it as the global
// `maplibregl` that the classic renderer scripts use; module scripts run
// before DOMContentLoaded, where the map is created.
import * as maplibregl from '../../assets/vendor/maplibre/maplibre-gl.mjs';

// MapLibre derives its worker URL only for http(s) pages; name the bundled
// worker explicitly for this file:// renderer.
maplibregl.setWorkerUrl(new URL('../../assets/vendor/maplibre/maplibre-gl-worker.mjs', import.meta.url).href);

window.maplibregl = maplibregl;
