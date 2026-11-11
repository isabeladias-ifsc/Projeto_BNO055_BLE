// ============================================================================
// Central BNO055 - Dashboard multi-sensor (Cliente Web Bluetooth)
// ============================================================================

const CONFIG = {
  remap: (x, y, z) => ({ x: x, y: z, z: -y }),
  mountOffsetDeg: { x: 90, y: 0, z: 0 },
  zuptJerkThreshold: 0.09,
  zuptHoldMs: 120,
  biasLearnRate: 0.02,
  velocityDamping: 0.985,
  autoResetPositionHoldMs: 500,
  impactThresholdG: 0.5,
  trailMaxPoints: 600,
  quatSlerpFactor: 0.35,
  chartHistorySeconds: 8,
  reconnectDelayMs: 1000,
};

const $ = (id) => document.getElementById(id);
const fmt = (n, d = 2) => (typeof n === 'number' ? n.toFixed(d) : '--');

// ============================================================================
// ESTADO POR SENSOR
// ============================================================================
function createSensorState() {
  return {
    lastPacketTime: 0,
    packetTimes: [],
    lastDeviceT: null,

    latestQuat: new THREE.Quaternion(),
    displayQuat: new THREE.Quaternion(),

    velocity: new THREE.Vector3(),
    position: new THREE.Vector3(),
    belowThresholdSince: null,

    accelBias: new THREE.Vector3(),
    lastRawAccelWorld: null,
    jerkEma: 0,
    autoResetDone: false,

    trailPoints: [],
    trailVisible: true,

    history: [],
    lastImpactAboveThreshold: false,
    lastImpactG: 0,
  };
}

const sensors = new Map(); // id -> { meta, state, tile }
let modalSensorId = null;

// ============================================================================
// GEOMETRIA E MATERIAIS DO AVATAR
// ============================================================================
const FACE_PROJECTION_SCALE = 3.6;

function createFaceHeadGeometry(radius) {
  const geo = new THREE.SphereGeometry(radius, 24, 18);
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (z > 0) {
      const div = radius * FACE_PROJECTION_SCALE;
      uv.setXY(i, THREE.MathUtils.clamp(x / div + 0.5, 0, 1), THREE.MathUtils.clamp(y / div + 0.5, 0, 1));
    } else {
      uv.setXY(i, 0.02, 0.5);
    }
  }
  uv.needsUpdate = true;
  return geo;
}

const HEAD_RADIUS = 0.24;

const sharedGeo = {
  head: createFaceHeadGeometry(HEAD_RADIUS),
  torso: new THREE.BoxGeometry(0.42, 0.5, 0.24),
  pelvis: new THREE.BoxGeometry(0.34, 0.24, 0.22),
  arm: new THREE.CylinderGeometry(0.06, 0.05, 0.58, 10),
  leg: new THREE.CylinderGeometry(0.095, 0.08, 0.75, 10),
  patch: new THREE.BoxGeometry(0.16, 0.16, 0.02),
  belt: new THREE.BoxGeometry(0.44, 0.08, 0.28),
};

function weaveBackground(ctx, size, base, light, dark) {
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = light;
  ctx.lineWidth = 2;
  for (let i = -size; i < size * 2; i += 9) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + size, size); ctx.stroke();
  }
  ctx.strokeStyle = dark;
  for (let i = -size; i < size * 2; i += 9) {
    ctx.beginPath(); ctx.moveTo(i, size); ctx.lineTo(i + size, 0); ctx.stroke();
  }
}

function createGiLimbTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  weaveBackground(ctx, size, '#e9e4d8', 'rgba(255,255,255,0.4)', 'rgba(0,0,0,0.06)');
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function createGiTorsoTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  weaveBackground(ctx, size, '#e9e4d8', 'rgba(255,255,255,0.4)', 'rgba(0,0,0,0.06)');

  ctx.fillStyle = 'rgba(0,0,0,0.16)';
  ctx.beginPath();
  ctx.moveTo(size * 0.5, size * 0.06);
  ctx.lineTo(size * 0.22, size * 0.62);
  ctx.lineTo(size * 0.34, size * 0.62);
  ctx.lineTo(size * 0.5, size * 0.22);
  ctx.closePath();
  ctx.fill();

  const tex = new THREE.CanvasTexture(canvas);
  return tex;
}

const BELT_COLOR = 0x1a1a1a;

const sharedMat = {
  torso: new THREE.MeshStandardMaterial({ map: createGiTorsoTexture(), color: 0xffffff, roughness: 0.85 }),
  limb: new THREE.MeshStandardMaterial({ map: createGiLimbTexture(), color: 0xffffff, roughness: 0.85 }),
  belt: new THREE.MeshStandardMaterial({ color: BELT_COLOR, roughness: 0.7 }),
  head: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 }),
  patch: new THREE.MeshStandardMaterial({ color: 0x3fd0ff, emissive: 0x0c2430, emissiveIntensity: 0.5 }),
};

const AVATAR_LOOK_TARGET = new THREE.Vector3(0, 0.05, 0);

function createSensorMeshGroup() {
  const group = new THREE.Group();
  group.add(new THREE.Mesh(sharedGeo.torso, sharedMat.torso));

  const pelvis = new THREE.Mesh(sharedGeo.pelvis, sharedMat.limb);
  pelvis.position.y = -0.37;
  group.add(pelvis);

  const belt = new THREE.Mesh(sharedGeo.belt, sharedMat.belt);
  belt.position.y = -0.25;
  group.add(belt);

  const head = new THREE.Mesh(new THREE.SphereGeometry(HEAD_RADIUS, 32, 32), sharedMat.head);
  head.position.y = 0.25 + HEAD_RADIUS;
  group.add(head);

  [-1, 1].forEach((side) => {
    const arm = new THREE.Mesh(sharedGeo.arm, sharedMat.limb);
    arm.position.set(side * 0.26, -0.05, 0);
    group.add(arm);

    const leg = new THREE.Mesh(sharedGeo.leg, sharedMat.limb);
    leg.position.set(side * 0.12, -0.865, 0);
    group.add(leg);
  });

  return group;
}

function lightScene(scene) {
  scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x0a0a12, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 0.9);
  key.position.set(3, 5, 4);
  scene.add(key);
}

// ============================================================================
// CONEXÃO WEB BLUETOOTH
// ============================================================================
const BLE_SERVICE_UUID = '4fafc201-1fb5-459e-8fcc-c5c9c331914b';
const BLE_CHAR_UUID    = 'beb5483e-36e1-4688-b7f5-ea07361b26a8'; // Corrigido para corresponder à ESP32

let bluetoothDevice = null;
let bluetoothCharacteristic = null;

async function connectServer() {
  try {
    $('serverText').textContent = 'a procurar dispositivos...';
    
    bluetoothDevice = await navigator.bluetooth.requestDevice({
      filters: [{ name: 'ESP32_Judo_Mestre' }],
      optionalServices: [BLE_SERVICE_UUID]
    });

    bluetoothDevice.addEventListener('gattserverdisconnected', onDisconnected);

    $('serverText').textContent = 'a conectar ao GATT...';
    const server = await bluetoothDevice.gatt.connect();

    $('serverText').textContent = 'a procurar serviço...';
    const service = await server.getPrimaryService(BLE_SERVICE_UUID);

    $('serverText').textContent = 'a ativar notificações...';
    bluetoothCharacteristic = await service.getCharacteristic(BLE_CHAR_UUID);

    await bluetoothCharacteristic.startNotifications();
    bluetoothCharacteristic.addEventListener('characteristicvaluechanged', handleBLESideData);

    $('serverDot').className = 'dot ok';
    $('serverText').textContent = 'conectado via Bluetooth';

    // Garante que ambos os lutadores aparecem no dashboard
    ensureSensor({ id: 'slave', name: 'Lutador 1 (Escravo)', status: 'online' });
    ensureSensor({ id: 'master', name: 'Lutador 2 (Mestre)', status: 'online' });
    updateGlobalStats();

  } catch (error) {
    console.error('Erro na conexão Bluetooth:', error);
    $('serverDot').className = 'dot';
    $('serverText').textContent = 'falha na conexão (clique para tentar)';
  }
}

function onDisconnected() {
  $('serverDot').className = 'dot';
  $('serverText').textContent = 'desconectado (clique para reconectar)';
}

// O Mestre envia o JSON unificado: {"slave":{...},"master":{...}}
function handleBLESideData(event) {
  const decoder = new TextDecoder('utf-8');
  const jsonString = decoder.decode(event.target.value);

  try {
    const data = JSON.parse(jsonString);
    
    if (data.slave) {
      applyIncomingData('slave', { t: performance.now(), ...data.slave }, true);
    }
    if (data.master) {
      applyIncomingData('master', { t: performance.now(), ...data.master }, true);
    }
  } catch (e) {
    console.warn("JSON parcial ou corrompido:", e);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const serverStatusEl = $('serverText').parentElement;
  if (serverStatusEl) {
    serverStatusEl.style.cursor = 'pointer';
    serverStatusEl.addEventListener('click', () => {
      if (!bluetoothDevice || !bluetoothDevice.gatt.connected) {
        connectServer();
      }
    });
  }
});

function ensureSensor(meta) {
  if (sensors.has(meta.id)) return sensors.get(meta.id);
  const entry = { meta: { ...meta }, state: createSensorState(), tile: null };
  entry.tile = buildSensorTile(entry);
  sensors.set(meta.id, entry);
  renderTileStatus(entry);
  addToUnifiedScene(entry);
  return entry;
}

function updateGlobalStats() {
  const total = sensors.size;
  let online = 0;
  sensors.forEach((s) => { if (s.meta.status === 'online') online++; });
  $('sensorsOnlineText').textContent = `${online} / ${total}`;
}

function buildSensorTile(entry) {
  const root = document.createElement('div');
  root.className = 'sensorTile';
  root.innerHTML = `
    <div class="tileHead">
      <span class="dot" data-el="dot"></span>
      <span class="name" data-el="name"></span>
      <span class="statusText" data-el="statusText"></span>
    </div>
    <div class="tile3d" data-el="viewport"></div>
    <div class="tileMetrics">
      <div><label>Impacto</label><span data-el="impact">0.00 g</span></div>
      <div><label>Vel.</label><span data-el="speed">0.00 m/s</span></div>
      <div><label>Latência</label><span data-el="lat">-- ms</span></div>
    </div>
  `;
  root.addEventListener('click', () => openModal(entry.meta.id));

  const grid = $('tilesGrid');
  grid.appendChild(root);

  const viewportEl = root.querySelector('[data-el="viewport"]');
  const scene = new THREE.Scene();
  lightScene(scene);
  const sensorGroup = createSensorMeshGroup();
  scene.add(sensorGroup);

  const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 1000);
  camera.position.set(2.2, 1.3, 2.9);
  camera.lookAt(AVATAR_LOOK_TARGET);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(280, 200);
  viewportEl.appendChild(renderer.domElement);

  return {
    root,
    dot: root.querySelector('[data-el="dot"]'),
    name: root.querySelector('[data-el="name"]'),
    statusText: root.querySelector('[data-el="statusText"]'),
    impactEl: root.querySelector('[data-el="impact"]'),
    speedEl: root.querySelector('[data-el="speed"]'),
    latEl: root.querySelector('[data-el="lat"]'),
    scene, camera, renderer, sensorGroup
  };
}

function renderTileStatus(entry) {
  const { tile, meta } = entry;
  tile.name.textContent = meta.name || meta.id;
  tile.dot.className = 'dot ok';
  tile.statusText.textContent = 'online';
}

function renderTileMetrics(entry) {
  const { tile, state } = entry;
  tile.impactEl.textContent = fmt(state.lastImpactG, 2) + ' g';
  tile.speedEl.textContent = fmt(state.velocity.length()) + ' m/s';
  tile.latEl.textContent = state.lastPacketTime ? Math.max(0, performance.now() - state.lastPacketTime).toFixed(0) + ' ms' : '-- ms';
}

let unifiedScene, unifiedCamera, unifiedRenderer;
const UNIFIED_SPACING = 1.7;
let unifiedCount = 0;

function initUnifiedScene() {
  const viewportEl = $('unifiedViewport');
  unifiedScene = new THREE.Scene();
  lightScene(unifiedScene);

  unifiedCamera = new THREE.PerspectiveCamera(50, 1, 0.05, 1000);
  unifiedCamera.position.set(0, 1.5, 5);
  unifiedCamera.lookAt(0, 0, 0);

  unifiedRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  unifiedRenderer.setSize(viewportEl.clientWidth || 600, 380);
  viewportEl.appendChild(unifiedRenderer.domElement);
}

function addToUnifiedScene(entry) {
  if (!unifiedScene) initUnifiedScene();
  const avatar = createSensorMeshGroup();
  avatar.position.x = (unifiedCount === 0 ? -0.8 : 0.8); // Posiciona um à esquerda e outro à direita
  unifiedScene.add(avatar);
  unifiedCount++;
  entry.unified = { avatar };
}

function applyIncomingData(sensorId, data, isLive) {
  const entry = sensors.get(sensorId) || ensureSensor({ id: sensorId, name: sensorId, status: 'online' });
  const { state } = entry;

  if (isLive) entry.meta.lastSeen = Date.now();
  state.lastPacketTime = performance.now();

  // Atualiza orientação baseada nos ângulos de Euler (Yaw, Pitch, Roll) recebidos da ESP32
  if (data.yaw !== undefined && data.pitch !== undefined && data.roll !== undefined) {
    const y = THREE.MathUtils.degToRad(data.yaw);
    const p = THREE.MathUtils.degToRad(data.pitch);
    const r = THREE.MathUtils.degToRad(data.roll);
    state.displayQuat.setFromEuler(new THREE.Euler(p, y, r, 'YXZ'));
  }

  renderTileMetrics(entry);
  if (entry.unified) {
    entry.unified.avatar.quaternion.copy(state.displayQuat);
  }
}

// Loop de renderização contínua
function animate() {
  requestAnimationFrame(animate);
  if (unifiedRenderer && unifiedScene && unifiedCamera) {
    unifiedRenderer.render(unifiedScene, unifiedCamera);
  }
  sensors.forEach(entry => {
    if (entry.tile && entry.tile.renderer && entry.tile.scene && entry.tile.camera) {
      if (entry.unified) entry.tile.sensorGroup.quaternion.copy(entry.state.displayQuat);
      entry.tile.renderer.render(entry.tile.scene, entry.tile.camera);
    }
  });
}
animate();

// ============================================================================
// FUNÇÕES DE INTERAÇÃO (Modal de Detalhes e Grade Comparativa)
// ============================================================================

// Abre o modal de detalhe ao clicar num card de sensor
function openModal(id) {
  if (!sensors.has(id)) return;
  modalSensorId = id;
  const modalEl = $('detailModal');
  if (modalEl) modalEl.hidden = false;
  
  const entry = sensors.get(id);
  if (entry) {
    $('detailName').textContent = entry.meta.name || entry.meta.id;
  }
}

// Fecha o modal de detalhe
document.addEventListener('DOMContentLoaded', () => {
  const btnClose = $('btnCloseModal');
  if (btnClose) {
    btnClose.addEventListener('click', () => {
      const modalEl = $('detailModal');
      if (modalEl) modalEl.hidden = true;
      modalSensorId = null;
    });
  }

  // Alternância entre Grade Individual e Grade Comparativa
  document.querySelectorAll('.viewTab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      document.querySelectorAll('.viewTab').forEach(b => b.classList.toggle('active', b === btn));
      
      const tilesGrid = $('tilesGrid');
      const compView = $('comparisonView');
      
      if (tilesGrid) tilesGrid.hidden = (view !== 'grid');
      if (compView) compView.hidden = (view !== 'comparison');
    });
  });
});
