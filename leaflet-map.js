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

  function markerIcon({ label, color, branch, grouped }) {
    const size = branch ? 30 : grouped ? 34 : 28;
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

    let current = null;
    let openGroup = null;

    function groupOrders(orders) {
      const points = orders.map(order=>map.latLngToContainerPoint(toLatLng(screenToGeo(order.x,order.y))));
      const parents = orders.map((_,i)=>i);
      const root = i => { while(parents[i]!==i) i=parents[i]; return i; };
      for(let i=0;i<orders.length;i++) for(let j=0;j<i;j++) {
        if (Math.hypot(points[i].x-points[j].x,points[i].y-points[j].y)<28) parents[root(i)]=root(j);
      }
      const groups = new Map();
      orders.forEach((order,i)=>{const key=root(i);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(order);});
      return [...groups.values()];
    }

    function render() {
      if (!current) return;
      const { orders, routes, markerMeta, onOrderClick } = current;
      const restoreGroup = openGroup;
      dynamic.clearLayers();
      routes.forEach(route => {
        L.polyline(route.points.map(([x, y]) => toLatLng(screenToGeo(x, y))), {
          color: route.color, weight: 5, opacity: route.opacity ?? 0.9,
          dashArray: route.dash === 'none' ? null : '8 6', interactive: false
        }).addTo(dynamic);
      });
      for (const group of groupOrders(orders)) {
        const key=group.map(order=>order.id).sort().join('|');
        const grouped=group.length>1;
        const colors=new Set(group.map(order=>markerMeta[order.id]?.color || '#9A9C98'));
        const color=colors.size===1 ? [...colors][0] : '#16181A';
        const point=[group.reduce((sum,o)=>sum+o.x,0)/group.length,group.reduce((sum,o)=>sum+o.y,0)/group.length];
        const order=group[0], meta=markerMeta[order.id] || {};
        const marker=L.marker(toLatLng(screenToGeo(...point)), {
          icon:markerIcon({label:grouped ? `×${group.length}` : String(meta.n || '·'),color,grouped}),
          title:grouped ? `В этой точке: ${group.length} заказов — открыть список` : `${order.number ? '№'+order.number : order.id} · ${order.address}`,
          zIndexOffset:grouped ? 500 : 0, bubblingMouseEvents:false
        }).addTo(dynamic);
        if (!grouped) { marker.on('click',()=>onOrderClick(order.id)); continue; }
        marker.bindTooltip(`${group.length} заказов рядом · нажмите, чтобы выбрать`,{direction:'top'});
        const panel=document.createElement('div');
        panel.style.cssText='min-width:230px;max-height:280px;overflow:auto;font:12px IBM Plex Sans,system-ui,sans-serif';
        L.DomEvent.disableClickPropagation(panel);
        L.DomEvent.disableScrollPropagation(panel);
        const heading=document.createElement('div');
        heading.textContent=`Заказы в этой точке: ${group.length}`;
        heading.style.cssText='font-weight:600;margin-bottom:8px';
        panel.append(heading);
        group.forEach(order=>{
          const item=markerMeta[order.id] || {};
          const button=document.createElement('button');
          button.type='button';
          button.style.cssText=`display:block;width:100%;text-align:left;padding:8px;margin:4px 0;border:1px solid #DADAD3;border-left:4px solid ${item.color || '#9A9C98'};border-radius:5px;background:#fff;cursor:pointer`;
          const label=document.createElement('div');
          label.textContent=`${order.number ? '№'+order.number : order.id}${item.bucket ? ' · Bucket '+item.bucket+' · остановка '+item.n : ' · без бакета'}`;
          label.style.fontWeight='600';
          const details=document.createElement('div');
          details.textContent=`${item.eta ? 'ETA '+item.eta+' · ' : ''}готов ${order.ready} · до ${order.deadline}`;
          details.style.cssText='font-size:11px;color:#6B6E70;margin-top:3px';
          button.append(label,details);
          button.addEventListener('click',event=>{event.stopPropagation();openGroup=null;map.closePopup();onOrderClick(order.id);});
          panel.append(button);
        });
        marker.bindPopup(panel,{maxWidth:330,autoPan:true});
        marker.on('popupopen',()=>{openGroup=key;});
        marker.on('popupclose',()=>{if(openGroup===key)openGroup=null;});
        if (key===restoreGroup) marker.openPopup();
      }
    }
    map.on('zoomend',render);
    return {
      update(input) { current=input; render(); },
      destroy() { current=null; map.off('zoomend',render); map.remove(); }
    };

  }

  window.RoutingLabMap = { create, screenToGeo, geoToScreen };
})();
