// =============================================================
//  app.js — 足迹地图 · Mapbox GL JS 地图引擎
// =============================================================

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const MAPBOX_TOKEN = 'pk.eyJ1Ijoic3VuMjAwMjEyMTMiLCJhIjoiY21xM210djd2MHU2djJyc2UxYmwzYWp5ayJ9.fvsS9v2jg-2eUS3xRBgceQ';

// ─── 状态 ──────────────────────────────────────────────────
const state = {
  viewLevel: 'city',
  visitedCities: new Set(),
  visitedProvinces: new Set(),
  isExporting: false,
};

// ─── 全局 ──────────────────────────────────────────────────
let map, popup;
let mapReady = false;
let dataLoaded = false;
const centroidCache = {};

// ─── 色彩系统 ─────────────────────────────────────────────
const C = {
  visited: '#b8e3ff',
  visitedStroke: '#7abdff',
  visitedHalo: 'rgba(184,227,255,0.5)',
  visitedHaloLight: 'rgba(184,227,255,0.35)',
  unvisited: '#eef0f4',
  unvisitedHover: '#ced2db',
  dot: '#4a9eff',
  dotStroke: '#ffffff',
};

const COLOR_SCHEMES = [
  { id: 'a', name: '冰川',
    visited: '#b8e3ff', visitedStroke: '#7abdff',
    visitedHalo: 'rgba(184,227,255,0.5)', visitedHaloLight: 'rgba(184,227,255,0.35)',
    unvisited: '#eef0f4', unvisitedHover: '#ced2db',
    dot: '#4a9eff', dotStroke: '#ffffff' },
  { id: 'b', name: '日落',
    visited: '#fad6b3', visitedStroke: '#e8b88a',
    visitedHalo: 'rgba(250,214,179,0.5)', visitedHaloLight: 'rgba(250,214,179,0.35)',
    unvisited: '#f2efe9', unvisitedHover: '#e2dcd0',
    dot: '#d4915a', dotStroke: '#ffffff' },
  { id: 'c', name: '森林',
    visited: '#b5dcc0', visitedStroke: '#7fc098',
    visitedHalo: 'rgba(181,220,192,0.5)', visitedHaloLight: 'rgba(181,220,192,0.35)',
    unvisited: '#eff0ec', unvisitedHover: '#dadecf',
    dot: '#5a9e7a', dotStroke: '#ffffff' },
];

// ─── 工具 ──────────────────────────────────────────────────
function showToast(msg, type = 'success') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast';
  void t.offsetWidth;
  t.classList.add('show', type);
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2500);
}

function getCityFeatures() {
  if (!window.CITY_GEOJSON || !window.CITY_GEOJSON.features) return [];
  return window.CITY_GEOJSON.features.filter(f => f.geometry.type === 'MultiPolygon');
}

function getBoundaryFeatures() {
  if (!window.CITY_GEOJSON || !window.CITY_GEOJSON.features) return [];
  return window.CITY_GEOJSON.features.filter(f => f.geometry.type !== 'MultiPolygon');
}

function getProvinceFromFeature(f) {
  const gb = f.properties.gb || '';
  return getProvinceByGB(gb) || getProvinceOfCity(f.properties.name) || '未知';
}

function abbreviateProvince(name) {
  return name.replace('维吾尔自治区','').replace('壮族自治区','')
    .replace('回族自治区','').replace('自治区','')
    .replace('特别行政区','').replace('省','').replace('市','');
}

function getCentroidLngLat(feature) {
  const key = feature.properties.name + (feature.properties.gb || '');
  if (centroidCache[key]) return centroidCache[key];
  try {
    const c = d3.geoPath().centroid(feature);
    centroidCache[key] = { lng: c[0], lat: c[1] };
  } catch {
    centroidCache[key] = { lng: 104, lat: 35 };
  }
  return centroidCache[key];
}

// ─── 地图初始化 ────────────────────────────────────────────
function initMap() {
  mapboxgl.accessToken = MAPBOX_TOKEN;

  map = new mapboxgl.Map({
    container: 'map-container',
    style: 'mapbox://styles/mapbox/light-v11',
    center: [104, 35],
    zoom: 3,
    attributionControl: true,
    preserveDrawingBuffer: true,
  });

  popup = new mapboxgl.Popup({
    closeButton: false,
    closeOnClick: false,
    maxWidth: '260px',
  });

  map.on('load', () => {
    // 去掉底图所有注记、国境线、道路等
    const layers = map.getStyle().layers;
    layers.forEach(l => {
      const isOurs = l.id.startsWith('city-') || l.id.startsWith('visited-') ||
                     l.id.startsWith('province-') || l.id.startsWith('boundary-') ||
                     l.id === 'province-borders';
      if (isOurs) return;
      if (l.type === 'background' || l.type === 'fill') return;
      map.setLayoutProperty(l.id, 'visibility', 'none');
    });

    mapReady = true;
    loadMapData();
    setupMapInteraction();
    if (dataLoaded) syncAll();
  });

  map.on('resize', () => {
    if (dataLoaded) fitBounds();
  });
}

// ─── 加载地理数据到 Mapbox ─────────────────────────────────
function loadMapData() {
  if (!window.CITY_GEOJSON || !mapReady) return;

  const cityFeatures = getCityFeatures();
  if (!cityFeatures.length) return;

  // 添加短名（去掉 市/地区/自治州/盟 等后缀）
  cityFeatures.forEach(f => {
    f.properties.shortName = shortName(f.properties.name);
  });

  // 1. 城市多边形
  map.addSource('cities', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: cityFeatures },
    promoteId: 'gb',
  });

  // 填充层（使用 feature-state 控制颜色）
  map.addLayer({
    id: 'city-fill',
    type: 'fill',
    source: 'cities',
    paint: {
      'fill-color': [
        'case',
        ['boolean', ['feature-state', 'visited'], false],
        C.visited,
        C.unvisited
      ],
      'fill-opacity': [
        'case',
        ['boolean', ['feature-state', 'hover'], false],
        ['case', ['boolean', ['feature-state', 'visited'], false], 0.95, 0.7],
        ['case', ['boolean', ['feature-state', 'visited'], false], 0.85, 0.5]
      ],
    },
  });

  // 描边层
  map.addLayer({
    id: 'city-outline',
    type: 'line',
    source: 'cities',
    paint: {
      'line-color': [
        'case',
        ['boolean', ['feature-state', 'visited'], false],
        C.visitedStroke,
        'rgba(0,0,0,0.06)'
      ],
      'line-width': [
        'case',
        ['boolean', ['feature-state', 'visited'], false],
        1, 0.4
      ],
    },
  });

  // 2. 边界线
  const bounds = getBoundaryFeatures();
  if (bounds.length) {
    map.addSource('boundaries', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: bounds },
    });
    map.addLayer({
      id: 'boundary-lines',
      type: 'line',
      source: 'boundaries',
      paint: {
        'line-color': 'rgba(0,0,0,0.07)',
        'line-width': 0.6,
        'line-dasharray': [2, 3],
      },
    });
  }

  // 3. 省级标签源（点）
  buildProvinceLabelSource();

  // 4. 城市几何中心点源（D3 精确计算，非 Mapbox 自动推算）
  const centroidFeatures = cityFeatures.map(f => {
    const c = getCentroidLngLat(f);
    return {
      type: 'Feature',
      properties: { name: f.properties.name, gb: f.properties.gb, shortName: f.properties.shortName || shortName(f.properties.name) },
      geometry: { type: 'Point', coordinates: [c.lng, c.lat] },
    };
  });
  map.addSource('city-centroids', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: centroidFeatures },
    promoteId: 'gb',
  });

  // 5. 已访问城市圆点（省级视图专用，基于精确几何中心）
  map.addLayer({
    id: 'visited-dots',
    type: 'circle',
    source: 'city-centroids',
    filter: ['in', 'gb', ''],
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': 7,
      'circle-color': C.dot,
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 2.5,
      'circle-opacity': 0.95,
    },
  });

  // 5. 城市标签层（市级视图）
  map.addLayer({
    id: 'city-labels',
    type: 'symbol',
    source: 'city-centroids',
    filter: ['in', 'gb', ''],
    layout: {
      'text-field': ['get', 'shortName'],
      'text-font': ['Noto Sans CJK JP Bold'],
      'text-size': 11,
      'text-anchor': 'center',
      'text-allow-overlap': true,
      'text-ignore-placement': true,
    },
    paint: {
      'text-color': '#1e293b',
      'text-halo-color': C.visitedHalo,
      'text-halo-width': 1.5,
    },
  });

  // 5. 省级标签层
  map.addLayer({
    id: 'province-labels',
    type: 'symbol',
    source: 'province-centroids',
    layout: {
      'text-field': ['get', 'shortName'],
      'text-font': ['Noto Sans CJK JP Bold'],
      'text-size': 13,
      'text-anchor': 'center',
      'text-letter-spacing': 0.05,
      'text-allow-overlap': true,
      'text-ignore-placement': true,
    },
    paint: {
      'text-color': '#64748b',
      'text-halo-color': '#ffffff',
      'text-halo-width': 2,
    },
  });

  // 6. 省界（直接使用省 GeoJSON）
  if (window.PROVINCE_GEOJSON) {
    const provPolys = window.PROVINCE_GEOJSON.features.filter(
      f => f.geometry.type === 'MultiPolygon'
    );
    if (provPolys.length) {
      map.addSource('province-boundaries', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: provPolys },
        promoteId: 'gb',
        maxzoom: 14,
        tolerance: 0,
      });
      map.addLayer({
        id: 'province-borders',
        type: 'line',
        source: 'province-boundaries',
        layout: { visibility: 'none' },
        paint: {
          'line-color': [
            'case',
            ['boolean', ['feature-state', 'visited'], false],
            C.visitedStroke,
            'rgba(0,0,0,0.06)'
          ],
          'line-width': [
            'case',
            ['boolean', ['feature-state', 'visited'], false],
            0.8, 0.3
          ],
        },
      });
    }
  }

  // 初始可见性
  updateLayerVisibility();

  dataLoaded = true;
  fitBounds();
  syncAll();
}

/** 计算省级标签点 */
function buildProvinceLabelSource() {
  const groups = {};
  getCityFeatures().forEach(f => {
    const province = getProvinceFromFeature(f);
    if (!groups[province]) groups[province] = [];
    groups[province].push(getCentroidLngLat(f));
  });

  const features = Object.entries(groups).map(([name, pts]) => {
    const avgLng = pts.reduce((s, c) => s + c.lng, 0) / pts.length;
    const avgLat = pts.reduce((s, c) => s + c.lat, 0) / pts.length;
    return {
      type: 'Feature',
      properties: { name, shortName: abbreviateProvince(name) },
      geometry: { type: 'Point', coordinates: [avgLng, avgLat] },
    };
  });

  if (map.getSource('province-centroids')) {
    map.getSource('province-centroids').setData({ type: 'FeatureCollection', features });
  } else {
    map.addSource('province-centroids', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features },
    });
  }
}

// ─── 自适应缩放 ────────────────────────────────────────────
function fitBounds() {
  if (!dataLoaded || !map.getSource('cities')) return;
  const bounds = new mapboxgl.LngLatBounds();
  getCityFeatures().forEach(f => {
    try {
      const c = getCentroidLngLat(f);
      bounds.extend([c.lng, c.lat]);
    } catch {}
  });
  if (!bounds.isEmpty()) {
    map.fitBounds(bounds, { padding: 30, maxZoom: 7 });
  }
}

// ─── 交互事件 ──────────────────────────────────────────────
let hoveredGb = null;

function setupMapInteraction() {
  // 鼠标移入 → 高亮 + 提示
  map.on('mousemove', 'city-fill', (e) => {
    if (!e.features || !e.features.length) return;
    const feat = e.features[0];
    const gb = feat.properties.gb;
    const name = feat.properties.name;
    const province = getProvinceFromFeature(feat);
    const visited = state.viewLevel === 'province'
      ? state.visitedProvinces.has(province)
      : state.visitedCities.has(name);

    if (hoveredGb && hoveredGb !== gb) {
      map.setFeatureState({ source: 'cities', id: hoveredGb }, { hover: false });
    }
    hoveredGb = gb;
    map.setFeatureState({ source: 'cities', id: gb }, { hover: true });
    map.getCanvas().style.cursor = 'pointer';

    const label = state.viewLevel === 'province'
      ? `${province}${visited ? ' (已访问)' : ' — 点击标记'}`
      : `${name} · ${province}${visited ? ' (已访问)' : ' — 点击标记'}`;
    popup.setLngLat(e.lngLat).setText(label).addTo(map);
  });

  // 移出 → 还原
  map.on('mouseleave', 'city-fill', () => {
    if (hoveredGb) {
      map.setFeatureState({ source: 'cities', id: hoveredGb }, { hover: false });
      hoveredGb = null;
    }
    map.getCanvas().style.cursor = '';
    popup.remove();
  });

  // 点击 → 切换访问状态
  map.on('click', 'city-fill', (e) => {
    if (state.isExporting || !e.features || !e.features.length) return;
    const feat = e.features[0];
    const name = feat.properties.name;
    const province = getProvinceFromFeature(feat);
    if (state.viewLevel === 'province') {
      toggleProvince(province);
    } else {
      toggleCity(name, province);
    }
  });

  // ── 省级视图圆点交互 ──
  map.on('mousemove', 'visited-dots', (e) => {
    if (!e.features || !e.features.length) return;
    const feat = e.features[0];
    const name = feat.properties.name;
    const province = getProvinceFromFeature(feat);
    map.getCanvas().style.cursor = 'pointer';
    popup.setLngLat(e.lngLat)
      .setText(`${name} · ${province}${state.visitedCities.has(name) ? ' (已访问)' : ''}`)
      .addTo(map);
  });
  map.on('mouseleave', 'visited-dots', () => {
    map.getCanvas().style.cursor = '';
    popup.remove();
  });
  map.on('click', 'visited-dots', (e) => {
    if (state.isExporting || !e.features || !e.features.length) return;
    const feat = e.features[0];
    toggleCity(feat.properties.name, getProvinceFromFeature(feat));
  });
}

// ─── 同步状态到地图 ────────────────────────────────────────
function syncFeatureStates() {
  if (!dataLoaded || !map.getSource('cities')) return;
  const features = getCityFeatures();
  features.forEach(f => {
    const gb = f.properties.gb;
    if (!gb) return;
    const name = f.properties.name;
    const visited = state.viewLevel === 'province'
      ? state.visitedProvinces.has(getProvinceFromFeature(f))
      : state.visitedCities.has(name);
    try {
      map.setFeatureState({ source: 'cities', id: gb }, { visited });
    } catch {}
  });
  // 同步省界 feature-state
  if (map.getSource('province-boundaries') && window.PROVINCE_GEOJSON) {
    const provs = window.PROVINCE_GEOJSON.features.filter(f => f.geometry.type === 'MultiPolygon');
    provs.forEach(f => {
      const gb = f.properties.gb;
      if (!gb) return;
      try {
        map.setFeatureState({ source: 'province-boundaries', id: gb },
          { visited: state.visitedProvinces.has(f.properties.name) });
      } catch {}
    });
  }
}

function updateLabels() {
  if (!dataLoaded) return;

  // 市级标签：只显示已访问城市
  const visitedGbs = getCityFeatures()
    .filter(f => state.visitedCities.has(f.properties.name))
    .map(f => f.properties.gb)
    .filter(Boolean);

  try {
    map.setFilter('city-labels', ['in', 'gb', ...visitedGbs]);
  } catch {}

  // 省级视图圆点过滤
  try {
    map.setFilter('visited-dots', ['in', 'gb', ...visitedGbs]);
  } catch {}

  // 省级标签颜色
  try {
    const provinceSource = map.getSource('province-centroids');
    if (provinceSource) {
      const groups = {};
      getCityFeatures().forEach(f => {
        const province = getProvinceFromFeature(f);
        if (!groups[province]) groups[province] = { pts: [], visited: state.visitedProvinces.has(province) };
        groups[province].pts.push(getCentroidLngLat(f));
      });
      const features = Object.entries(groups).map(([name, g]) => {
        const avgLng = g.pts.reduce((s, c) => s + c.lng, 0) / g.pts.length;
        const avgLat = g.pts.reduce((s, c) => s + c.lat, 0) / g.pts.length;
        return {
          type: 'Feature',
          properties: {
            name,
            shortName: abbreviateProvince(name),
            visited: g.visited,
            color: g.visited ? '#ffffff' : '#64748b',
          },
          geometry: { type: 'Point', coordinates: [avgLng, avgLat] },
        };
      });
      provinceSource.setData({ type: 'FeatureCollection', features });

      // 更新省级标签样式（利用 data-driven 属性）
      map.setPaintProperty('province-labels', 'text-color', [
        'case',
        ['boolean', ['get', 'visited'], false],
        '#1e293b',
        '#64748b'
      ]);
      map.setPaintProperty('province-labels', 'text-halo-color', [
        'case',
        ['boolean', ['get', 'visited'], false],
        C.visitedHaloLight,
        '#ffffff'
      ]);
    }
  } catch {}
}

function updateLayerVisibility() {
  if (!dataLoaded) return;
  const p = state.viewLevel === 'province';
  try {
    map.setLayoutProperty('city-fill', 'visibility', 'visible');
    // 市级视图显示市界，省级视图隐藏
    map.setLayoutProperty('city-outline', 'visibility', p ? 'none' : 'visible');
    if (!p) {
      map.setPaintProperty('city-outline', 'line-width', [
        'case', ['boolean', ['feature-state', 'visited'], false], 0.6, 0.2
      ]);
    }
    map.setLayoutProperty('city-labels', 'visibility', p ? 'none' : 'visible');
    map.setLayoutProperty('visited-dots', 'visibility', p ? 'visible' : 'none');
    map.setLayoutProperty('province-labels', 'visibility', p ? 'visible' : 'none');
    // 省界图层（类似市界的逻辑）
    if (map.getLayer('province-borders')) {
      map.setLayoutProperty('province-borders', 'visibility', p ? 'visible' : 'none');
      if (p) {
        map.setPaintProperty('province-borders', 'line-width', [
          'case', ['boolean', ['feature-state', 'visited'], false], 1.2, 0.5
        ]);
      }
    }
  } catch {}
}

function syncAll() {
  syncFeatureStates();
  updateLabels();
  updateLayerVisibility();
}

// ─── 交互 ──────────────────────────────────────────────────
function toggleProvince(provinceName) {
  if (state.visitedProvinces.has(provinceName)) {
    state.visitedProvinces.delete(provinceName);
    showToast(`已移除 ${provinceName}`);
  } else {
    state.visitedProvinces.add(provinceName);
    showToast(`已标记 ${provinceName}`);
  }
  saveState(); syncAll(); updateUI();
}

function toggleCity(cityName, provinceName) {
  if (!cityName) return;
  const pn = provinceName || getProvinceOfCity(cityName) || '';
  if (state.visitedCities.has(cityName)) {
    state.visitedCities.delete(cityName);
    if (![...state.visitedCities].some(c => getProvinceOfCity(c) === pn)) state.visitedProvinces.delete(pn);
    showToast(`已移除 ${cityName}`);
  } else {
    state.visitedCities.add(cityName);
    if (pn) state.visitedProvinces.add(pn);
    showToast(`已标记 ${cityName}${pn ? ' · '+pn : ''}`);
  }
  saveState(); syncAll(); updateUI();
}

function addCityByName(cityName) {
  const n = cityName.trim();
  if (!n) return false;

  // 解析不完整名称为完整官方名称（如 "武汉" → "武汉市"，"大兴安岭" → "大兴安岭地区"）
  const results = searchCities(n);
  const targetName = results.length > 0 ? results[0].name : n;

  const p = getProvinceOfCity(targetName);
  if (!p) { showToast(`未找到 "${n}"`, 'error'); return false; }
  if (state.visitedCities.has(targetName)) { showToast(`${targetName} 已在足迹中`); return true; }
  state.visitedCities.add(targetName);
  state.visitedProvinces.add(p);
  saveState(); syncAll(); updateUI();
  showToast(`已添加 ${targetName}`);
  return true;
}

function removeCity(cityName) {
  state.visitedCities.delete(cityName);
  const p = getProvinceOfCity(cityName);
  if (p && ![...state.visitedCities].some(c => getProvinceOfCity(c) === p)) state.visitedProvinces.delete(p);
  saveState(); syncAll(); updateUI();
}

// ─── 导出图片 ──────────────────────────────────────────────
function exportImage() {
  if (state.isExporting) return;
  state.isExporting = true;
  const btn = $('#exportBtn');
  const orig = btn.textContent;
  btn.textContent = '导出中...';
  btn.disabled = true;
  popup.remove();

  setTimeout(() => {
    try {
      const canvas = map.getCanvas();
      canvas.toBlob(blob => {
        if (!blob || blob.size < 200) {
          showToast('导出失败', 'error');
          btn.textContent = orig;
          btn.disabled = false;
          state.isExporting = false;
          return;
        }
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.download = `足迹地图_${new Date().toISOString().slice(0,10)}.png`;
        link.href = url;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        showToast('图片已导出');
        btn.textContent = orig;
        btn.disabled = false;
        state.isExporting = false;
      }, 'image/png');
    } catch (e) {
      console.error(e);
      showToast('导出失败', 'error');
      btn.textContent = orig;
      btn.disabled = false;
      state.isExporting = false;
    }
  }, 200);
}

// ─── UI ────────────────────────────────────────────────────
function updateUI() {
  updateCityList();
  updateViewToggle();
  // 统计
  const allCities = getAllCities().filter(c =>
    c.name.endsWith('市')||c.name.endsWith('州')||c.name.endsWith('盟')||
    c.name.endsWith('地区')||c.name==='香港特别行政区'||c.name==='澳门特别行政区');
  $('#cityStatCount').textContent = state.visitedCities.size;
  $('#cityStatTotal').textContent = allCities.length;
  $('#provinceStatCount').textContent = state.visitedProvinces.size;
  $('#provinceStatTotal').textContent = PROVINCES.length;
  const pct = allCities.length>0 ? state.visitedCities.size/allCities.length*100 : 0;
  $('#cityProgressFill').style.width = Math.min(pct,100)+'%';
}

function updateCityList() {
  const list = $('#cityList'), count = $('#cityCount');
  const v = [...state.visitedCities];
  if (!v.length) {
    list.innerHTML = '<div class="empty-state">还没有添加任何城市</div>';
    count.textContent = '0'; return;
  }
  count.textContent = v.length;
  list.innerHTML = v.sort((a,b)=>a.localeCompare(b,'zh-CN')).map(n => {
    const p = getProvinceOfCity(n)||'';
    const dp = p&&p!==n ? p.replace(/省|自治区|特别行政区/g,'').replace(/壮族|回族|维吾尔/g,'') : '';
    return `<div class="city-item"><div class="city-info"><span class="city-dot"></span><span class="city-name">${n}</span></div><div style="display:flex;align-items:center;gap:8px;"><span class="city-province">${dp||''}</span><button class="remove-btn" data-city="${n}">x</button></div></div>`;
  }).join('');
  list.querySelectorAll('.remove-btn').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); removeCity(b.dataset.city); }));
}

function updateViewToggle() {
  $$('.view-toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.view === state.viewLevel));
}

// ─── 搜索 ──────────────────────────────────────────────────
function setupSearch() {
  const input = $('#searchInput'), dropdown = $('#searchDropdown');
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length<1) { dropdown.classList.remove('active'); return; }
    timer = setTimeout(() => renderResults(searchCities(q)), 150);
  });
  input.addEventListener('focus', () => { if (input.value.trim().length>=1) renderResults(searchCities(input.value.trim())); });
  document.addEventListener('click', e => { if (!e.target.closest('.search-section')) dropdown.classList.remove('active'); });
  input.addEventListener('keydown', e => {
    if (e.key==='Enter') { const r=searchCities(input.value.trim()); if(r.length){addCityByName(r[0].name);input.value='';dropdown.classList.remove('active');} }
    if (e.key==='Escape') { dropdown.classList.remove('active'); input.blur(); }
  });
  $('#addCityBtn').addEventListener('click', () => { const q=input.value.trim(); if(q&&addCityByName(q)){input.value='';dropdown.classList.remove('active');} });

  function renderResults(r) {
    if (!r.length) { dropdown.classList.remove('active'); return; }
    dropdown.classList.add('active');
    dropdown.innerHTML = r.map(x => {
      const a = state.visitedCities.has(x.name);
      return `<div class="search-dropdown-item ${a?'added':''}" data-city="${x.name}"><span class="city-name">${x.name}</span><span><span class="province-tag">${x.province.replace(/省|自治区|特别行政区/g,'').replace(/壮族|回族|维吾尔/g,'')}</span>${a?'<span class="added-badge"> 已添加</span>':''}</span></div>`;
    }).join('');
    dropdown.querySelectorAll('.search-dropdown-item:not(.added)').forEach(item => {
      item.addEventListener('click', () => { addCityByName(item.dataset.city); input.value=''; dropdown.classList.remove('active'); input.focus(); });
    });
  }
}

// ─── 地名缩写 ─────────────────────────────────────────────
// 自治州的正确短名映射
const AZHOU_SHORT = {
  '延边朝鲜族自治州':'延边','恩施土家族苗族自治州':'恩施',
  '湘西土家族苗族自治州':'湘西','凉山彝族自治州':'凉山',
  '甘孜藏族自治州':'甘孜','阿坝藏族羌族自治州':'阿坝',
  '黔东南苗族侗族自治州':'黔东南','黔南布依族苗族自治州':'黔南',
  '黔西南布依族苗族自治州':'黔西南','西双版纳傣族自治州':'西双版纳',
  '大理白族自治州':'大理','德宏傣族景颇族自治州':'德宏',
  '怒江傈僳族自治州':'怒江','迪庆藏族自治州':'迪庆',
  '文山壮族苗族自治州':'文山','红河哈尼族彝族自治州':'红河',
  '楚雄彝族自治州':'楚雄','海北藏族自治州':'海北',
  '黄南藏族自治州':'黄南','海南藏族自治州':'海南',
  '果洛藏族自治州':'果洛','玉树藏族自治州':'玉树',
  '海西蒙古族藏族自治州':'海西','昌吉回族自治州':'昌吉',
  '博尔塔拉蒙古自治州':'博尔塔拉','巴音郭楞蒙古自治州':'巴音郭楞',
  '克孜勒苏柯尔克孜自治州':'克孜勒苏','伊犁哈萨克自治州':'伊犁',
  '临夏回族自治州':'临夏','甘南藏族自治州':'甘南',
};

function shortName(name) {
  // 自治州查白名单
  if (AZHOU_SHORT[name]) return AZHOU_SHORT[name];
  // 常规后缀
  return name
    .replace(/市$/, '').replace(/地区$/, '')
    .replace(/盟$/, '').replace(/特别行政区$/, '');
}

// ─── 配色切换 ─────────────────────────────────────────────
function applyColorScheme(id) {
  const s = id === 'custom' ? parseCustomColors() : COLOR_SCHEMES.find(x => x.id === id);
  if (!s) return;
  Object.assign(C, s);

  // 更新 CSS 变量（侧边栏）
  document.documentElement.style.setProperty('--accent', C.visited);
  document.documentElement.style.setProperty('--accent-deep', C.dot);

  // 标记选中
  $$('.scheme-swatch').forEach(el => el.classList.toggle('active', el.dataset.scheme === id));

  // 更新地图 paint 属性
  if (!dataLoaded) return;
  try {
    map.setPaintProperty('city-fill', 'fill-color', [
      'case', ['boolean', ['feature-state', 'visited'], false], C.visited, C.unvisited
    ]);
    map.setPaintProperty('city-outline', 'line-color', [
      'case', ['boolean', ['feature-state', 'visited'], false], C.visitedStroke, 'rgba(0,0,0,0.06)'
    ]);
    try {
      map.setPaintProperty('province-borders', 'line-color', [
        'case', ['boolean', ['feature-state', 'visited'], false], C.visitedStroke, 'rgba(0,0,0,0.06)'
      ]);
    } catch {}
    map.setPaintProperty('visited-dots', 'circle-color', C.dot);
    map.setPaintProperty('city-labels', 'text-halo-color', C.visitedHalo);
    map.setPaintProperty('province-labels', 'text-halo-color', [
      'case', ['boolean', ['get', 'visited'], false], C.visitedHaloLight, '#ffffff'
    ]);
    map.setPaintProperty('province-labels', 'text-color', [
      'case', ['boolean', ['get', 'visited'], false], '#1e293b', '#64748b'
    ]);
  } catch (e) { /* layer not ready yet */ }
  syncFeatureStates();
}

function parseCustomColors() {
  return {
    visited: $('#customVis').value,
    visitedStroke: adjustBrightness($('#customVis').value, -15),
    visitedHalo: hexToRgba($('#customVis').value, 0.5),
    visitedHaloLight: hexToRgba($('#customVis').value, 0.35),
    unvisited: $('#customUnvis').value,
    unvisitedHover: adjustBrightness($('#customUnvis').value, -12),
    dot: adjustBrightness($('#customVis').value, -25),
    dotStroke: '#ffffff',
  };
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1,3), 16);
  const g = parseInt(hex.slice(3,5), 16);
  const b = parseInt(hex.slice(5,7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function adjustBrightness(hex, amount) {
  const r = Math.max(0, Math.min(255, parseInt(hex.slice(1,3), 16) + amount));
  const g = Math.max(0, Math.min(255, parseInt(hex.slice(3,5), 16) + amount));
  const b = Math.max(0, Math.min(255, parseInt(hex.slice(5,7), 16) + amount));
  return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
}

function setupColorPalette() {
  $$('.scheme-swatch').forEach(el => {
    el.addEventListener('click', () => {
      if (el.dataset.scheme === 'custom') {
        $('#customColors').style.display = 'flex';
        return;
      }
      $('#customColors').style.display = 'none';
      applyColorScheme(el.dataset.scheme);
    });
  });

  $('#applyCustom').addEventListener('click', () => {
    applyColorScheme('custom');
  });

  // 读取上次保存的配色
  const saved = localStorage.getItem('fp_color_scheme');
  if (saved) applyColorScheme(saved);
}

function setupViewToggle() {
  $$('.view-toggle-btn').forEach(b => {
    b.addEventListener('click', () => {
      if (b.dataset.view === state.viewLevel) return;
      state.viewLevel = b.dataset.view;
      syncAll();
      updateUI();
      saveState();
    });
  });
}

// ─── 存储 ──────────────────────────────────────────────────
function saveState() {
  try {
    localStorage.setItem('fp_visited_cities', JSON.stringify([...state.visitedCities]));
    localStorage.setItem('fp_visited_provinces', JSON.stringify([...state.visitedProvinces]));
    localStorage.setItem('fp_view_level', state.viewLevel);
    localStorage.setItem('fp_color_scheme', C.id || 'a');
  } catch {}
}
function loadState() {
  try {
    const c = localStorage.getItem('fp_visited_cities');
    const p = localStorage.getItem('fp_visited_provinces');
    const l = localStorage.getItem('fp_view_level');
    if (c) JSON.parse(c).forEach(x => state.visitedCities.add(x));
    if (p) JSON.parse(p).forEach(x => state.visitedProvinces.add(x));
    if (l==='province'||l==='city') state.viewLevel = l;
  } catch {}
}

// ─── 快捷键 ────────────────────────────────────────────────
function setupKeyboard() {
  document.addEventListener('keydown', e => {
    if ((e.metaKey||e.ctrlKey)&&e.key==='s') { e.preventDefault(); exportImage(); }
    if (e.key==='/'&&!e.ctrlKey&&!e.metaKey) {
      const i = $('#searchInput');
      if (i&&document.activeElement!==i) { e.preventDefault(); i.focus(); }
    }
  });
}

// ─── 移动端引导（首次访问提示展开侧边栏）───────────────
function setupMobileOnboarding() {
  if (!window.matchMedia('(orientation: portrait)').matches) return;

  // 默认收起侧边栏
  $('#sidebar').classList.add('collapsed');

  // 已引导过则跳过
  if (localStorage.getItem('fp_hint_dismissed')) return;

  const toggle = $('#sidebarToggle');
  toggle.classList.add('hint-active');

  const dismissHint = () => {
    toggle.classList.remove('hint-active');
    localStorage.setItem('fp_hint_dismissed', 'true');
    toggle.removeEventListener('click', dismissHint);
  };

  // 首次点击☰后永久消除引导
  toggle.addEventListener('click', dismissHint, { once: true });
}

// ─── 初始化 ────────────────────────────────────────────────
function init() {
  loadState();
  initMap();

  if (window.CITY_GEOJSON) {
    dataLoaded = true;
    if (mapReady) { loadMapData(); syncAll(); }
  } else {
    const chk = setInterval(() => {
      if (window.CITY_GEOJSON) {
        clearInterval(chk);
        dataLoaded = true;
        if (mapReady) { loadMapData(); syncAll(); }
      }
    }, 100);
  }

  setupSearch();
  setupViewToggle();
  setupColorPalette();
  setupKeyboard();
  setupMobileOnboarding();
  $('#exportBtn').addEventListener('click', exportImage);
  $('#resetBtn').addEventListener('click', () => {
    state.visitedCities.clear();
    state.visitedProvinces.clear();
    saveState();
    syncAll();
    updateUI();
    showToast('已清空所有足迹');
  });
  $('#sidebarToggle').addEventListener('click', () => {
    $('#sidebar').classList.toggle('collapsed');
    setTimeout(() => map.resize(), 350);
  });
  updateUI();
}

document.addEventListener('DOMContentLoaded', init);
