// ============================================================================
// CONFIGURAÇÃO E VARIÁVEIS GLOBAIS DE BLUETOOTH
// ============================================================================
const BLE_SERVICE_UUID = "beb5483e-36e1-4688-b7f5-ea07361b26a8";
const BLE_CHAR_UUID    = "beb5483e-36e1-4688-b7f5-ea07361b26a8";

let bluetoothDevice = null;
let bluetoothCharacteristic = null;
let sensors = new Map();
let modalSensorId = null;

const AVATAR_LOOK_TARGET = { x: 0, y: 0.8, z: 0 };

function $(id) {
  return document.getElementById(id);
}

// ============================================================================
// EXPORTAÇÃO GLOBAL DA FUNÇÃO MODAL (Evita ReferenceError)
// ============================================================================
window.openModal = function(id) {
  if (!sensors.has(id)) return;
  modalSensorId = id;
  const modalEl = $('detailModal');
  if (modalEl) modalEl.hidden = false;
  
  const entry = sensors.get(id);
  if (entry) {
    const nameEl = $('detailName');
    if (nameEl) nameEl.textContent = entry.meta.name || entry.meta.id;
  }
};

// ============================================================================
// CONEXÃO BLUETOOTH (Web Bluetooth)
// ============================================================================
async function connectServer() {
  try {
    $('serverText').textContent = 'a procurar dispositivos...';
    
    bluetoothDevice = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
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

    // Criação inicial dos avatares para Master e Slave
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
  $('serverText').textContent = 'desconectado (clique para religar)';
  sensors.forEach(entry => {
    entry.statusText.textContent = 'OFFLINE';
    entry.dot.className = 'dot';
  });
  updateGlobalStats();
}

// ============================================================================
// PROCESSAMENTO DOS DADOS RECEBIDOS DA ESP32
// ============================================================================
function handleBLESideData(event) {
  try {
    const value = event.target.value;
    const decoder = new TextDecoder('utf-8');
    const jsonString = decoder.decode(value);
    
    const data = JSON.parse(jsonString);
    
    // Processa dados do Escravo, se existirem
    if (data.slave) {
      updateSensorData('slave', {
        name: 'Lutador 1 (Escravo)',
        status: 'online',
        quat: data.slave.quat,
        impact: data.slave.impact || 0,
        speed: data.slave.speed || 0,
        lat: data.slave.lat || 15
      });
    }

    // Processa dados do Mestre, se existirem
    if (data.master) {
      updateSensorData('master', {
        name: 'Lutador 2 (Mestre)',
        status: 'online',
        quat: data.master.quat,
        impact: data.master.impact || 0,
        speed: data.master.speed || 0,
        lat: data.master.lat || 15
      });
    }

    updateGlobalStats();
  } catch (e) {
    console.error('Erro ao interpretar JSON do BLE:', e);
  }
}

// ============================================================================
// GESTÃO E RENDERIZAÇÃO DOS AVATARES 3D (Three.js)
// ============================================================================
function ensureSensor(meta) {
  if (sensors.has(meta.id)) {
    const entry = sensors.get(meta.id);
    entry.meta = { ...entry.meta, ...meta };
    entry.name.textContent = entry.meta.name;
    return entry;
  }

  const tile = buildSensorTile(meta);
  sensors.set(meta.id, { meta, ...tile });
  return sensors.get(meta.id);
}

function updateSensorData(id, payload) {
  const entry = ensureSensor({ id, name: payload.name, status: payload.status });
  
  entry.statusText.textContent = 'ONLINE';
  entry.dot.className = 'dot ok';

  if (payload.impact !== undefined) entry.impactEl.textContent = Number(payload.impact).toFixed(2) + ' g';
  if (payload.speed !== undefined)  entry.speedEl.textContent  = Number(payload.speed).toFixed(2) + ' m/s';
  if (payload.lat !== undefined)    entry.latEl.textContent    = payload.lat + ' ms';

  // Atualiza rotação 3D com base no Quatérnion do BNO055
  if (payload.quat) {
    const q = payload.quat;
    entry.sensorGroup.quaternion.set(q.x, q.y, q.z, q.w);
  }

  // Renderiza a cena 3D
  entry.renderer.render(entry.scene, entry.camera);
}

function updateGlobalStats() {
  let onlineCount = 0;
  sensors.forEach(entry => {
    if (entry.meta.status === 'online') onlineCount++;
  });
  const sensorsCountEl = $('sensorsCount');
  if (sensorsCountEl) {
    sensorsCountEl.textContent = `${onlineCount} / ${Math.max(sensors.size, 2)}`;
  }
}

function lightScene(scene) {
  const ambient = new THREE.AmbientLight(0xffffff, 0.9);
  scene.add(ambient);
  const dir = new THREE.DirectionalLight(0xffffff, 0.6);
  dir.position.set(5, 10, 7);
  scene.add(dir);
}

function createSensorMeshGroup() {
  const group = new THREE.Group();
  
  // Corpo do boneco / estrutura representativa
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 });
  const headGeo = new THREE.SphereGeometry(0.2, 16, 16);
  const head = new THREE.Mesh(headGeo, mat);
  head.position.y = 0.9;
  group.add(head);

  const torsoGeo = new THREE.BoxGeometry(0.35, 0.5, 0.2);
  const torso = new THREE.Mesh(torsoGeo, mat);
  torso.position.y = 0.5;
  group.add(torso);

  return group;
}

function buildSensorTile(meta) {
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
  
  // Chama a função global window.openModal ao clicar no cartão
  root.addEventListener('click', () => {
    window.openModal(entry.meta.id);
  });

  const grid = $('tilesGrid');
  if (grid) grid.appendChild(root);

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

// ============================================================================
// INICIALIZAÇÃO DOS EVENTOS DA INTERFACE (DOM)
// ============================================================================
document.addEventListener('DOMContentLoaded', () => {
  // Evento para iniciar a conexão ao clicar no cabeçalho/servidor
  const serverConnEl = $('serverConnection');
  if (serverConnEl) {
    serverConnEl.addEventListener('click', connectServer);
  }

  // Evento para fechar o modal de detalhes
  const btnClose = $('btnCloseModal');
  if (btnClose) {
    btnClose.addEventListener('click', () => {
      const modalEl = $('detailModal');
      if (modalEl) modalEl.hidden = true;
      modalSensorId = null;
    });
  }

  // Alternância de abas (Grade Individual vs Grade Comparativa)
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
