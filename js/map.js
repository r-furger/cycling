// Leaflet map, free Swiss base layers, route/plan/POI layers.
const CH = L.latLngBounds([45.6, 5.7], [47.95, 10.7]);
const WMTS = id => `https://wmts.geo.admin.ch/1.0.0/${id}/default/current/3857/{z}/{x}/{y}`;

export const BASE_LAYERS = {
  'swisstopo-color': { label: 'swisstopo national map', url: WMTS('ch.swisstopo.pixelkarte-farbe') + '.jpeg', maxNativeZoom: 18, attribution: '© swisstopo', swiss: true },
  'swisstopo-grey': { label: 'swisstopo grey', url: WMTS('ch.swisstopo.pixelkarte-grau') + '.jpeg', maxNativeZoom: 18, attribution: '© swisstopo', swiss: true },
  'swisstopo-aerial': { label: 'swisstopo aerial imagery', url: WMTS('ch.swisstopo.swissimage') + '.jpeg', maxNativeZoom: 19, attribution: '© swisstopo', swiss: true },
  'cyclosm': { label: 'CyclOSM (cycling map)', url: 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', maxNativeZoom: 19, attribution: 'CyclOSM · © OpenStreetMap contributors' },
  'osm': { label: 'OpenStreetMap', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxNativeZoom: 19, attribution: '© OpenStreetMap contributors' },
  'opentopo': { label: 'OpenTopoMap', url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', maxNativeZoom: 17, attribution: '© OpenTopoMap (CC-BY-SA) · © OpenStreetMap contributors' },
};
export const OVERLAYS = {
  'veloland': { label: 'Cycling routes (Veloland / SchweizMobil)', url: WMTS('ch.astra.veloland') + '.png', maxNativeZoom: 18, minZoom: 9, swiss: true, opacity: 0.85 },
  'mtbland': { label: 'Mountain bike routes', url: WMTS('ch.astra.mountainbikeland') + '.png', maxNativeZoom: 18, minZoom: 9, swiss: true, opacity: 0.85 },
  'pt-stops': { label: 'Public transport stops', url: WMTS('ch.bav.haltestellen-oev') + '.png', maxNativeZoom: 18, minZoom: 12, swiss: true, opacity: 1 },
};

function makeLayer(def) {
  return L.tileLayer(def.url, {
    maxNativeZoom: def.maxNativeZoom, maxZoom: 19, minZoom: def.minZoom || 0, attribution: def.attribution || '', subdomains: def.subdomains || 'abc',
    bounds: def.swiss ? CH : undefined, crossOrigin: def.swiss ? 'anonymous' : undefined, opacity: def.opacity ?? 1,
  });
}

export function createMap(el) {
  const map = L.map(el, { zoomControl: false, center: [46.8, 8.25], zoom: 8, minZoom: 6, maxZoom: 19 });
  L.control.zoom({ position: 'topright' }).addTo(map);
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);

  const layers = {}; let base = null;
  function setBase(id) {
    if (!BASE_LAYERS[id]) id = 'swisstopo-color';
    if (base) map.removeLayer(base.layer);
    base = { id, layer: layers[id] ||= makeLayer(BASE_LAYERS[id]) };
    base.layer.addTo(map); base.layer.bringToBack();
    return id;
  }
  function setOverlay(id, on) {
    const def = OVERLAYS[id]; if (!def) return;
    const l = layers['ov:' + id] ||= makeLayer(def);
    if (on) l.addTo(map); else map.removeLayer(l);
  }

  const routeGroup = L.layerGroup().addTo(map), planGroup = L.layerGroup().addTo(map), nearbyGroup = L.layerGroup().addTo(map);
  const trailLine = L.polyline([], { color: '#ff6f00', weight: 4, opacity: 0.9, dashArray: '6 6', interactive: false }).addTo(map);
  let routeLine = null, hoverMarker = null, posMarker = null, accCircle = null;

  function showRoute(points, { fit = true, color = '#d81b60' } = {}) {
    clearRoute();
    const ll = points.map(p => [p.lat, p.lon]);
    L.polyline(ll, { color: '#fff', weight: 9, opacity: 0.9, interactive: false }).addTo(routeGroup);
    routeLine = L.polyline(ll, { color, weight: 5, opacity: 0.95, interactive: false }).addTo(routeGroup);
    L.circleMarker(ll[0], { radius: 7, color: '#fff', weight: 2, fillColor: '#2e7d32', fillOpacity: 1, interactive: false }).addTo(routeGroup);
    L.circleMarker(ll[ll.length - 1], { radius: 7, color: '#fff', weight: 2, fillColor: '#c62828', fillOpacity: 1, interactive: false }).addTo(routeGroup);
    if (fit) fitRoute();
  }
  // Keep the route clear of the search bar, bottom sheet and elevation profile.
  function fitRoute() {
    if (!routeLine) return;
    const mobile = matchMedia('(max-width: 799px)').matches;
    const panel = document.getElementById('panel'), prof = document.getElementById('profile-box');
    const bottom = (mobile && panel ? panel.getBoundingClientRect().height : 0) + (prof && !prof.hidden ? prof.getBoundingClientRect().height : 0);
    map.fitBounds(routeLine.getBounds(), { paddingTopLeft: [30, 80], paddingBottomRight: [mobile ? 30 : 60, bottom + 30] });
  }
  function clearRoute() { routeGroup.clearLayers(); routeLine = null; }
  function setHover(p) {
    if (!p) { if (hoverMarker) map.removeLayer(hoverMarker); hoverMarker = null; return; }
    if (!hoverMarker) hoverMarker = L.circleMarker([p.lat, p.lon], { radius: 7, color: '#fff', weight: 2, fillColor: '#1565c0', fillOpacity: 1, interactive: false }).addTo(map);
    else hoverMarker.setLatLng([p.lat, p.lon]);
  }
  function setPosition(pos, heading) {
    const ll = [pos.lat, pos.lon];
    if (!posMarker) {
      posMarker = L.marker(ll, { icon: L.divIcon({ className: 'pos-marker', html: '<div class="pos-arrow"></div><div class="pos-dot"></div>', iconSize: [24, 24], iconAnchor: [12, 12] }), interactive: false, zIndexOffset: 1000 }).addTo(map);
      accCircle = L.circle(ll, { radius: pos.acc || 0, color: '#1976d2', weight: 1, fillOpacity: 0.1, interactive: false }).addTo(map);
    } else { posMarker.setLatLng(ll); accCircle.setLatLng(ll).setRadius(pos.acc || 0); }
    const arrow = posMarker.getElement()?.querySelector('.pos-arrow');
    if (arrow) { const h = heading ?? pos.heading; if (h != null && isFinite(h)) { arrow.style.display = 'block'; arrow.style.transform = `rotate(${h}deg)`; } else arrow.style.display = 'none'; }
  }
  function setTrail(points) { trailLine.setLatLngs(points.map(p => [p.lat, p.lon])); }

  function setWaypoints(wps, { onDrag, onClick }) {
    planGroup.clearLayers();
    wps.forEach((w, i) => {
      const cls = i === 0 ? 'start' : i === wps.length - 1 ? 'end' : '';
      const label = i === 0 ? 'S' : i === wps.length - 1 ? 'E' : i;
      const m = L.marker([w.lat, w.lon], { draggable: true, icon: L.divIcon({ className: 'wp-marker', html: `<div class="wp ${cls}">${label}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }) }).addTo(planGroup);
      m.on('dragend', () => { const ll = m.getLatLng(); onDrag(i, { lat: ll.lat, lon: ll.lng }); });
      m.on('click', () => onClick(i));
    });
  }

  function setNearby(items, popupFor) {
    nearbyGroup.clearLayers();
    for (const it of items) {
      if (it.geometry) L.polyline(it.geometry, { color: it.color, weight: 3, dashArray: '5 5', opacity: 0.9, interactive: false }).addTo(nearbyGroup);
      const m = L.marker([it.lat, it.lon], { icon: L.divIcon({ className: 'poi-marker', html: `<div class="poi" style="background:${it.color}">${it.glyph}</div>`, iconSize: [28, 28], iconAnchor: [14, 14], popupAnchor: [0, -14] }) }).addTo(nearbyGroup);
      m.bindPopup(() => popupFor(it), { maxWidth: 320, minWidth: 230 });
      it._marker = m;
    }
  }
  function clearNearby() { nearbyGroup.clearLayers(); }

  return { map, setBase, setOverlay, showRoute, clearRoute, fitRoute, hasRoute: () => !!routeLine, setHover, setPosition, setTrail, setWaypoints, setNearby, clearNearby };
}
