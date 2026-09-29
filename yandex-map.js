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

  async function loadApi(key, language) {
    if (window.ymaps3) { await window.ymaps3.ready; return window.ymaps3; }
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = `https://api-maps.yandex.ru/v3/?apikey=1250b3b7-55ec-4504-9dc1-8106b9b072ac&lang=${encodeURIComponent(language)}`;
      script.async = true;
      script.onload = resolve;
      script.onerror = () => reject(new Error('Не удалось загрузить Yandex Maps JavaScript API'));
      document.head.appendChild(script);
    });
    await window.ymaps3.ready;
    return window.ymaps3;
  }

  function markerElement({ label, color, title, branch, onClick }) {
    const root = document.createElement('button');
    root.type = 'button';
    root.title = title;
    root.setAttribute('aria-label', title);
    root.style.cssText = `width:${branch ? 30 : 28}px;height:${branch ? 30 : 28}px;border-radius:${branch ? 7 : 50}%;border:3px solid #fff;background:${color};color:#fff;font:700 11px IBM Plex Mono,monospace;box-shadow:0 2px 7px rgba(0,0,0,.28);display:grid;place-items:center;cursor:${branch ? 'default' : 'pointer'};transform:translate(-50%,-50%);padding:0`;
    root.textContent = label;
    if (onClick) root.addEventListener('click', event => { event.stopPropagation(); onClick(); });
    return root;
  }

  async function create(options) {
    const ymaps = await loadApi(options.key, options.language || 'ru_RU');
    const { YMap, YMapDefaultSchemeLayer, YMapDefaultFeaturesLayer, YMapFeature, YMapMarker, YMapListener } = ymaps;
    const map = new YMap(options.container, {
      location: { center: [options.branch.longitude, options.branch.latitude], zoom: 12.4 },
      behaviors: ['drag', 'scrollZoom', 'pinchZoom', 'dblClick']
    });
    map.addChild(new YMapDefaultSchemeLayer({}));
    map.addChild(new YMapDefaultFeaturesLayer({}));
    map.addChild(new YMapFeature({
      id: 'delivery-zone',
      geometry: { type: 'Polygon', coordinates: [options.branch.zone] },
      style: { fill: 'rgba(38,150,127,0.14)', stroke: [{ color: '#26967F', width: 3, dash: [7, 5] }] }
    }));
    map.addChild(new YMapMarker({
      coordinates: [options.branch.longitude, options.branch.latitude],
      source: 'routing-lab'
    }, markerElement({ label: 'Ф', color: '#16181A', title: options.branch.name.ru, branch: true })));
    map.addChild(new YMapListener({
      layer: 'any',
      onClick: (object, event) => {
        if (object) return;
        if (event?.coordinates) options.onMapClick(geoToScreen(event.coordinates), event.coordinates);
      }
    }));

    let dynamic = [];
    const removeDynamic = () => { dynamic.forEach(entity => map.removeChild(entity)); dynamic = []; };
    const add = entity => { dynamic.push(entity); map.addChild(entity); };

    return {
      update({ orders, routes, markerMeta, onOrderClick }) {
        removeDynamic();
        routes.forEach(route => {
          const coordinates = route.points.map(([x, y]) => screenToGeo(x, y));
          add(new YMapFeature({
            geometry: { type: 'LineString', coordinates },
            style: { stroke: [{ color: route.color, width: 5, opacity: route.opacity ?? 0.9, dash: route.dash === 'none' ? [] : [8, 6] }] }
          }));
        });
        orders.forEach(order => {
          const meta = markerMeta[order.id] || {};
          add(new YMapMarker({ coordinates: screenToGeo(order.x, order.y), source: 'routing-lab' }, markerElement({
            label: String(meta.n || '·'), color: meta.color || '#9A9C98', title: `${order.id} · ${order.address}`,
            onClick: () => onOrderClick(order.id)
          })));
        });
      },
      destroy() { removeDynamic(); map.destroy(); }
    };
  }

  window.RoutingLabYandexMap = { create, screenToGeo, geoToScreen };
})();
