(function () {
  const bounds = { minLon: 69.252, maxLon: 69.324, minLat: 41.314, maxLat: 41.359 };

  function screenToGeo(x, y) {
    return [
      bounds.minLon + (x - 40) / 720 * (bounds.maxLon - bounds.minLon),
      bounds.maxLat - (y - 35) / 530 * (bounds.maxLat - bounds.minLat)
    ];
  }

  function geoToScreen([longitude, latitude]) {
    return [
      Math.round((40 + (longitude - bounds.minLon) / (bounds.maxLon - bounds.minLon) * 720) * 10) / 10,
      Math.round((35 + (bounds.maxLat - latitude) / (bounds.maxLat - bounds.minLat) * 530) * 10) / 10
    ];
  }

  const toLatLng = ([longitude, latitude]) => [latitude, longitude];
  const escapeHtml = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  function markerIcon({ label, color, branch }) {
    const size = branch ? 30 : 28;
    const html = `<div style="width:${size}px;height:${size}px;box-sizing:border-box;border-radius:${branch ? '7px' : '50%'};border:3px solid #fff;background:${color};color:#fff;font:700 11px 'IBM Plex Mono',monospace;box-shadow:0 2px 7px rgba(0,0,0,.28);display:grid;place-items:center;cursor:${branch ? 'default' : 'pointer'}">${escapeHtml(label)}</div>`;
    return L.divIcon({ html, className: 'routing-lab-marker', iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
  }

  async function create(options) {
    if (!window.L) throw new Error('Не удалось загрузить Leaflet');
    const map = L.map(options.container, { zoomSnap: 0.1, zoomControl: false })
      .setView([options.branch.latitude, options.branch.longitude], 13.4);

    L.control.zoom({ position: 'bottomright' }).addTo(map);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);

    const zone = options.branch.zone.map(toLatLng);
    const world = [[-90, -180], [-90, 180], [90, 180], [90, -180]];
    // Затемняем всё вне зоны доставки, чтобы сама зона читалась сразу.
    L.polygon([world, zone], { stroke: false, fillColor: '#16181A', fillOpacity: 0.22, interactive: false }).addTo(map);
    // Белая подложка под контуром — контраст на любых тайлах.
    L.polygon(zone, { color: '#FFFFFF', weight: 8, opacity: 0.9, fill: false, interactive: false }).addTo(map);
    L.polygon(zone, {
      color: '#0B7A62', weight: 4, dashArray: '12 6', lineJoin: 'round',
      fillColor: '#1FA37F', fillOpacity: 0.2, interactive: false
    }).addTo(map);

    L.marker([options.branch.latitude, options.branch.longitude], {
      icon: markerIcon({ label: 'Ф', color: '#16181A', branch: true }),
      title: options.branch.name.ru, keyboard: false, interactive: false
    }).addTo(map);

    map.on('click', event => {
      const coordinates = [event.latlng.lng, event.latlng.lat];
      options.onMapClick(geoToScreen(coordinates), coordinates);
    });

    const dynamic = L.layerGroup().addTo(map);
    setTimeout(() => map.invalidateSize(), 0);

    return {
      update({ orders, routes, markerMeta, onOrderClick }) {
        dynamic.clearLayers();
        routes.forEach(route => {
          L.polyline(route.points.map(([x, y]) => toLatLng(screenToGeo(x, y))), {
            color: route.color, weight: 5, opacity: route.opacity ?? 0.9,
            dashArray: route.dash === 'none' ? null : '8 6', interactive: false
          }).addTo(dynamic);
        });
        orders.forEach(order => {
          const meta = markerMeta[order.id] || {};
          L.marker(toLatLng(screenToGeo(order.x, order.y)), {
            icon: markerIcon({ label: String(meta.n || '·'), color: meta.color || '#9A9C98' }),
            title: `${order.id} · ${order.address}`
          }).on('click', () => onOrderClick(order.id)).addTo(dynamic);
        });
      },
      destroy() { map.remove(); }
    };
  }

  window.RoutingLabMap = { create, screenToGeo, geoToScreen };
})();
