// ============================================================================
// Central BNO055 - Dashboard multi-sensor (cliente do servidor Node.js)
// ============================================================================
// Conecta em ws://<host>/dashboard (o servidor Node, nao o ESP32 direto).
// O servidor agrega quantos sensores estiverem em config/sensors.js e manda:
//   { type:'sensors', sensors:[...] }               - snapshot inicial
//   { type:'status', sensor:{...} }                  - sensor conectou/caiu
//   { type:'data', sensorId, data:{...} }              - telemetria ao vivo
//
// TODOS os sensores rodam o pipeline completo (orientacao, integracao de
// velocidade/posicao, historico p/ graficos) o tempo todo, porque todos
// ficam visiveis ao mesmo tempo na grade de cards (cada um com seu proprio
// mini-3D e mini-grafico). Clicar num card abre um modal com o dashboard
// completo (3D grande com orbit, todos os paineis, grade de 9 graficos).
// ============================================================================

const CONFIG = {
  remap: (x, y, z) => ({ x: x, y: z, z: -y }),

  // CALIBRACAO DE MONTAGEM: o sensor esta preso na lateral do corpo (nao
  // deitado nas costas), entao o chip fica fisicamente girado em relacao
  // ao corpo - sem essa correcao o avatar aparece deitado/de lado mesmo
  // com o atleta em pe. Ajuste estes 3 angulos (em graus) ate o avatar
  // ficar EM PE quando o atleta estiver parado, ereto, de frente pra
  // camera. Ordem: X = inclinar p/ frente/tras, Y = girar em pe (yaw),
  // Z = inclinar p/ os lados. Comece testando 90 ou -90 em um eixo por
  // vez (o mais comum p/ sensor na lateral/vertical e um offset de 90°
  // em X ou Z), recarregue a pagina e veja o resultado.
  mountOffsetDeg: { x: 90, y: 0, z: 0 },

  // ZUPT (Zero-Velocity Update) + compensacao de vies do acelerometro:
  // reduz bastante a deriva de posicao/velocidade (limitacao fisica de
  // qualquer IMU sem GPS/camera/baliza externa - o magnetometro nao
  // ajuda aqui, ele so corrige o "yaw" da orientacao, nao mede
  // deslocamento).
  //
  // "Parado" e detectado pela VARIACAO do sinal entre amostras (jerk),
  // nao pela magnitude absoluta - isso e de proposito: um sensor mal
  // calibrado tem um vies constante (ex.: sempre "puxando" pra cima),
  // que faria a magnitude nunca cair perto de zero mesmo parado. Uma
  // leitura CONSTANTE (mesmo que nao seja exatamente zero) ainda conta
  // como parada, porque o vies em si nao varia. Enquanto parado, o vies
  // atual e aprendido e subtraido de todas as leituras seguintes.
  zuptJerkThreshold: 0.09, // m/s^2 de variacao entre amostras - abaixo disso conta como "parado"
  zuptHoldMs: 120,          // tempo parado p/ zerar velocidade e aprender o vies
  biasLearnRate: 0.02,       // velocidade de aprendizado do vies (0-1, mais alto = mais rapido)
  velocityDamping: 0.985,     // amortecimento continuo por amostra (trade-off: mata movimento lento sustentado)

  // POSICAO nunca "sabe" voltar sozinha pro lugar fisico certo (sem
  // camera/GPS/marcador, so da pra integrar movimento relativo) - entao,
  // em vez disso, resetamos a posicao (nao so a velocidade) pra origem
  // sempre que ficar parado por tempo suficiente. Assim cada golpe/
  // movimento comeca do zero, e "voltar pro lugar" vira "ficar parado
  // um instante", que e um comportamento mais util na pratica. Aumente
  // se estiver resetando no meio de um movimento com pausas curtas.
  autoResetPositionHoldMs: 500,

  // Limiar (em g) de aceleracao LINEAR (gravidade ja removida pela fusao
  // do sensor) para registrar um "golpe" no log. Usamos "lia" (nao a
  // aceleracao bruta) de proposito: a bruta inclui a gravidade constante
  // (~1g), entao um golpe no MESMO sentido da gravidade se soma parcial
  // com ela e um golpe no sentido OPOSTO se cancela parcialmente - dava
  // pra golpe "so funcionar de um lado". A linear nao tem esse viés:
  // parte de ~0g em repouso, entao qualquer sentido de golpe soma direto.
  // Para calibrar: observe o numero "Magnitude do impacto" no painel (ou
  // no card do sensor) enquanto da uns tapas leves/fortes de VARIOS
  // sentidos, e ajuste este valor pra um pouco abaixo do menor golpe que
  // voce quer capturar.
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

    // compensacao de vies (bias) do acelerometro: aprendido/atualizado
    // enquanto o sensor esta "parado de verdade" (ver detectStillness);
    // sem isso, um sensor mal calibrado deriva sempre na mesma direcao,
    // mesmo com ZUPT zerando a velocidade entre movimentos.
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
// GEOMETRIA/MATERIAIS COMPARTILHADOS (varios sensores reaproveitam a mesma
// geometria/material - so os Object3D/Group sao unicos por sensor/viewport)
// ============================================================================
// Avatar humanoide simplificado (low-poly): o BNO055 fica nas costas do
// atleta, entao o corpo inteiro gira como corpo rigido seguindo a
// orientacao do sensor (nao ha como animar membros individualmente com
// apenas 1 IMU - a pose fica fixa, so a orientacao geral se move).
// Cabeca: esfera lisa e redonda, com a foto projetada de frente por cima.
// Zoom da foto projetada: divisor MAIOR = foto maior/mais ampliada
// (recorta so o centro da foto - onde fica o rosto numa foto tipo
// retrato - e espalha esse recorte por toda a area visivel da cabeca,
// sem sobra de cor solida nas bordas). Divisor MENOR = foto inteira
// encolhida num pontinho central. ~2.0 = a foto inteira preenche
// exatamente a frente da cabeca, sem cortar; acima disso, da zoom.
const FACE_PROJECTION_SCALE = 3.6;

function createFaceHeadGeometry(radius) {
  const geo = new THREE.SphereGeometry(radius, 24, 18);
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);

    // projecao frontal da foto (so nos vertices voltados pra camera);
    // vertices de tras da cabeca amostram a borda da foto (evita esticar)
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

// raio da cabeca - "bem grande" (estilo chibi/PS2); ajuste aqui se quiser
// maior/menor. O corpo continua no tamanho normal.
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

// Texturas proceduais (geradas em canvas, sem depender de imagem externa):
// dao ao avatar uma aparencia de quimono (gi) - tecido trancado em tom
// branco/cru, com a gola em V so no torso (os membros usam o tecido liso).
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
  for (let i = 0; i < 900; i++) {
    ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.03})`;
    ctx.fillRect(Math.random() * size, Math.random() * size, 1, 1);
  }
}

// tecido liso do gi (mangas/pernas) - sem gola, cor cru/branca
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

// torso do gi - mesmo tecido + gola em V cruzada (jaqueta amarrada)
function createGiTorsoTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  weaveBackground(ctx, size, '#e9e4d8', 'rgba(255,255,255,0.4)', 'rgba(0,0,0,0.06)');

  // gola em V cruzada (lapela esquerda sobre a direita, estilo gi/quimono)
  ctx.fillStyle = 'rgba(0,0,0,0.16)';
  ctx.beginPath();
  ctx.moveTo(size * 0.5, size * 0.06);
  ctx.lineTo(size * 0.22, size * 0.62);
  ctx.lineTo(size * 0.34, size * 0.62);
  ctx.lineTo(size * 0.5, size * 0.22);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(size * 0.5, size * 0.06);
  ctx.lineTo(size * 0.78, size * 0.62);
  ctx.lineTo(size * 0.66, size * 0.62);
  ctx.lineTo(size * 0.5, size * 0.22);
  ctx.closePath();
  ctx.fill();

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

// Cor da faixa (obi) - troque aqui se quiser refletir a graduacao do
// atleta (branca/azul/roxa/marrom/preta etc.)
const BELT_COLOR = 0x1a1a1a;

const sharedMat = {
  torso: new THREE.MeshStandardMaterial({ map: createGiTorsoTexture(), color: 0xffffff, metalness: 0.05, roughness: 0.85 }),
  limb: new THREE.MeshStandardMaterial({ map: createGiLimbTexture(), color: 0xffffff, metalness: 0.05, roughness: 0.85 }),
  belt: new THREE.MeshStandardMaterial({ color: BELT_COLOR, metalness: 0.1, roughness: 0.7 }),
  // cabeca redonda e lisa, com a foto projetada de frente
  	head: new THREE.MeshStandardMaterial({
  	color: 0xffffff,
  	metalness: 0.1,
  	roughness: 0.5,
	}),
  patch: new THREE.MeshStandardMaterial({ color: 0x3fd0ff, metalness: 0.2, roughness: 0.4, emissive: 0x0c2430, emissiveIntensity: 0.5 }),
};

// ponto que a camera mira - levemente abaixo da origem (peito, onde fica o
// sensor) pra enquadrar o avatar inteiro (cabeca aos pes), nao so o tronco
const AVATAR_LOOK_TARGET = new THREE.Vector3(0, 0.05, 0);

function createSensorMeshGroup() {
  const group = new THREE.Group();

  const torso = new THREE.Mesh(sharedGeo.torso, sharedMat.torso);
  group.add(torso);

  const pelvis = new THREE.Mesh(sharedGeo.pelvis, sharedMat.limb);
  pelvis.position.y = -0.37;
  group.add(pelvis);

  // faixa (obi) na cintura, entre o torso e a pelve
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

  // adesivo que marca onde o sensor fica montado (lateral do tronco,
  // altura das costelas) + seta indicando a frente do corpo - ajuda a
  // calibrar/entender a orientacao exibida. Se o sensor estiver no lado
  // esquerdo em vez do direito, troque o sinal de "0.22" (linha abaixo e
  // a seguinte) para "-0.22".
  const patch = new THREE.Mesh(sharedGeo.patch, sharedMat.patch);
  patch.position.set(0.22, 0.05, 0);
  patch.rotation.y = Math.PI / 2;
  group.add(patch);

  group.add(new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0.22, 0.05, 0), 0.5, 0xff5c7a, 0.14, 0.08));

  return group;
}

function lightScene(scene) {
  scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x0a0a12, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 0.9);
  key.position.set(3, 5, 4);
  scene.add(key);
}

// ============================================================================
// CONEXAO COM O SERVIDOR (nao com o ESP32 diretamente)
// ============================================================================// ============================================================================
// CONEXÃO WEB BLUETOOTH (Substitui o WebSocket para ligar direto ao ESP32 Hub)
// ============================================================================

// UUIDs configurados no Hub ESP32
const BLE_SERVICE_UUID = '4fafc201-1fb5-459e-8fcc-c5c9c331914b';
const BLE_CHAR_UUID    = 'beb5483e-36e1-4688-b7f5-ea07361b26aae';

let bluetoothDevice = null;
let bluetoothCharacteristic = null;

async function connectServer() {
  try {
    $('serverText').textContent = 'a procurar dispositivos...';
    
    // Solicita ao navegador para procurar o Hub ESP32 (filtrando pelo nome ou serviço)
    bluetoothDevice = await navigator.bluetooth.requestDevice({
      filters: [{ name: 'JudoHub' }],
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

    // Atualiza o indicador visual de conexão para verde (ok)
    $('serverDot').className = 'dot ok';
    $('serverText').textContent = 'conectado via Bluetooth';

    // Cria os dois sensores padrão na interface (Sensor 1 e Sensor 2)
    ensureSensor({ id: 'sensor_1', name: 'Sensor 1 (Ação)', status: 'online' });
    ensureSensor({ id: 'sensor_2', name: 'Sensor 2 (Resposta)', status: 'online' });
    updateGlobalStats();

  } catch (error) {
    console.error('Erro na conexão Bluetooth:', error);
    $('serverDot').className = 'dot';
    $('serverText').textContent = 'falha na conexão (clique para tentar)';
  }
}

function onDisconnected() {
  $('serverDot').className = 'dot';
  $('serverText').textContent = 'desconectado (reconectando...)';
  setTimeout(connectServer, CONFIG.reconnectDelayMs);
}

// Recebe os pacotes binários do ESP32 via BLE e converte para o formato do dashboard
function handleBLESideData(event) {
  const value = event.target.value;
  const decoder = new TextDecoder('utf-8');
  const jsonString = decoder.decode(value);

  try {
    const packet = JSON.parse(jsonString);
    // packet deve conter: { id: "sensor_1", t: ..., acc: {...}, lia: {...}, gyr: {...}, qua: {...}, ... }
    if (packet && packet.id) {
      applyIncomingData(packet.id, packet, true);
    }
  } catch (e) {
    console.error('Erro ao parsear JSON do BLE:', e);
  }
}

// Botão para disparar a conexão ao clicar no cabeçalho ou estado do servidor
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

function updateSensorMeta(meta) {
  const entry = sensors.get(meta.id);
  if (!entry) return;
  entry.meta = { ...entry.meta, ...meta };
  renderTileStatus(entry);
  if (meta.id === modalSensorId) renderDetailStatus(entry);
}

function updateGlobalStats() {
  const total = sensors.size;
  let online = 0;
  sensors.forEach((s) => { if (s.meta.status === 'online') online++; });
  $('sensorsOnlineText').textContent = `${online} / ${total}`;
}

// ============================================================================
// TILES DA GRADE - cada um tem seu proprio mini renderer 3D + mini grafico
// (todos ficam ativos ao mesmo tempo, entao dá pra ver varios sensores
// simultaneamente em 3D e nos graficos, nao so um de cada vez)
// ============================================================================
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
    <canvas class="tileChart" data-el="chart"></canvas>
  `;
  root.addEventListener('click', () => openModal(entry.meta.id));

  const grid = $('tilesGrid');
  const empty = grid.querySelector('.navEmpty');
  if (empty) empty.remove();
  grid.appendChild(root);

  const viewportEl = root.querySelector('[data-el="viewport"]');
  const scene = new THREE.Scene();
  lightScene(scene);
  const grid3d = new THREE.GridHelper(6, 12, 0x2a3550, 0x1a2136);
  grid3d.position.y = -1.25;
  scene.add(grid3d);
  const sensorGroup = createSensorMeshGroup();
  scene.add(sensorGroup);

  const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 1000);
  camera.position.set(2.2, 1.3, 2.9);
  camera.lookAt(AVATAR_LOOK_TARGET);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  viewportEl.appendChild(renderer.domElement);

  return {
    root,
    dot: root.querySelector('[data-el="dot"]'),
    name: root.querySelector('[data-el="name"]'),
    statusText: root.querySelector('[data-el="statusText"]'),
    impactEl: root.querySelector('[data-el="impact"]'),
    speedEl: root.querySelector('[data-el="speed"]'),
    latEl: root.querySelector('[data-el="lat"]'),
    chartCanvas: root.querySelector('[data-el="chart"]'),
    chartCtx: root.querySelector('[data-el="chart"]').getContext('2d'),
    viewportEl,
    scene,
    camera,
    renderer,
    sensorGroup,
    lastSize: { w: 0, h: 0 },
  };
}

function renderTileStatus(entry) {
  const { tile, meta } = entry;
  tile.name.textContent = meta.name || meta.id;
  tile.dot.className = 'dot ' + (meta.status === 'online' ? 'ok' : meta.status === 'connecting' ? 'warn' : 'offline');
  tile.statusText.textContent = meta.status === 'online' ? 'online' : meta.status === 'connecting' ? 'conectando' : 'offline';
}

function renderTileMetrics(entry) {
  const { tile, state } = entry;
  tile.impactEl.textContent = fmt(state.lastImpactG, 2) + ' g';
  tile.impactEl.classList.toggle('impactHigh', state.lastImpactG >= CONFIG.impactThresholdG);
  tile.speedEl.textContent = fmt(state.velocity.length()) + ' m/s';
  tile.latEl.textContent = state.lastPacketTime ? Math.max(0, performance.now() - state.lastPacketTime).toFixed(0) + ' ms' : '-- ms';
}

// ============================================================================
// VISAO UNIFICADA - todos os sensores juntos, na MESMA cena 3D, um do lado
// do outro (formato "linha") - alem da grade individual. Camera unica com
// orbit (arraste/zoom). Renderer proprio, criado sob demanda no primeiro
// sensor que aparecer.
// ============================================================================
let activeView = 'grid'; // 'grid' | 'unified'
let unifiedScene, unifiedCamera, unifiedRenderer;
let unifiedCam = { radius: 6.8, theta: 0.6, phi: 1.15 };
const UNIFIED_SPACING = 1.7;
let unifiedCount = 0;

function initUnifiedScene() {
  const viewportEl = $('unifiedViewport');
  unifiedScene = new THREE.Scene();
  lightScene(unifiedScene);

  const grid3d = new THREE.GridHelper(30, 60, 0x2a3550, 0x1a2136);
  grid3d.position.y = -1.25;
  unifiedScene.add(grid3d);

  unifiedCamera = new THREE.PerspectiveCamera(50, 1, 0.05, 1000);
  updateUnifiedCameraPosition();

  unifiedRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  unifiedRenderer.setPixelRatio(window.devicePixelRatio);
  viewportEl.appendChild(unifiedRenderer.domElement);

  let dragging = false, lastX = 0, lastY = 0;
  unifiedRenderer.domElement.addEventListener('pointerdown', (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; });
  window.addEventListener('pointerup', () => dragging = false);
  window.addEventListener('pointermove', (e) => {
    if (!dragging || activeView !== 'unified') return;
    unifiedCam.theta -= (e.clientX - lastX) * 0.005;
    unifiedCam.phi = Math.min(Math.max(unifiedCam.phi - (e.clientY - lastY) * 0.005, 0.2), Math.PI - 0.2);
    lastX = e.clientX; lastY = e.clientY;
    updateUnifiedCameraPosition();
  });
  unifiedRenderer.domElement.addEventListener('wheel', (e) => {
    if (activeView !== 'unified') return;
    unifiedCam.radius = Math.min(Math.max(unifiedCam.radius + e.deltaY * 0.006, 2), 40);
    updateUnifiedCameraPosition();
    e.preventDefault();
  }, { passive: false });
}

function unifiedCenterX() {
  return Math.max(0, unifiedCount - 1) * UNIFIED_SPACING / 2;
}

function updateUnifiedCameraPosition() {
  const cx = unifiedCenterX();
  unifiedCamera.position.set(
    cx + unifiedCam.radius * Math.sin(unifiedCam.phi) * Math.sin(unifiedCam.theta),
    unifiedCam.radius * Math.cos(unifiedCam.phi),
    unifiedCam.radius * Math.sin(unifiedCam.phi) * Math.cos(unifiedCam.theta)
  );
  unifiedCamera.lookAt(cx, 0.05, 0);
}

function resizeUnifiedRenderer() {
  const viewportEl = $('unifiedViewport');
  const w = viewportEl.clientWidth, h = viewportEl.clientHeight;
  if (!w || !h) return;
  unifiedCamera.aspect = w / h;
  unifiedCamera.updateProjectionMatrix();
  unifiedRenderer.setSize(w, h);
}

function addToUnifiedScene(entry) {
  if (!unifiedScene) initUnifiedScene();

  const avatar = createSensorMeshGroup();
  avatar.position.x = unifiedCount * UNIFIED_SPACING;
  unifiedScene.add(avatar);
  unifiedCount++;
  updateUnifiedCameraPosition();

  const label = document.createElement('div');
  label.className = 'unifiedLabel';
  label.textContent = entry.meta.name || entry.meta.id;
  $('unifiedLabels').appendChild(label);

  entry.unified = { avatar, label };
}

function renderUnifiedFrame() {
  if (!unifiedRenderer) return;
  resizeUnifiedRenderer();

  const viewportEl = $('unifiedViewport');
  const w = viewportEl.clientWidth, h = viewportEl.clientHeight;

  sensors.forEach((entry) => {
    if (!entry.unified) return;
    entry.unified.avatar.quaternion.copy(entry.state.displayQuat);

    if (!w || !h) return;
    const worldPos = entry.unified.avatar.position.clone();
    worldPos.y += 0.75;
    const screenPos = worldPos.project(unifiedCamera);
    const behind = screenPos.z > 1;
    entry.unified.label.style.opacity = behind ? '0' : '1';
    if (!behind) {
      const x = (screenPos.x * 0.5 + 0.5) * w;
      const y = (-screenPos.y * 0.5 + 0.5) * h;
      entry.unified.label.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
    }
  });

  unifiedRenderer.render(unifiedScene, unifiedCamera);
}

function switchView(view) {
  activeView = view;
  const tilesGrid = $('tilesGrid');
  const compView = $('comparisonView');
  
  if (tilesGrid) tilesGrid.hidden = view !== 'grid';
  if (compView) compView.hidden = view !== 'comparison';
  
  document.querySelectorAll('.viewTab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });
}

document.querySelectorAll('.viewTab').forEach((btn) => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

// ============================================================================
// MODAL - dashboard completo de UM sensor por vez (3D grande + orbit +
// todos os paineis + 9 graficos). Renderer criado sob demanda (lazy), na
// primeira vez que o modal abre, e reaproveitado nas aberturas seguintes.
// ============================================================================
let modalScene, modalCamera, modalRenderer, modalSensorGroup, modalTrailLine, modalTrailGeometry, modalTrailDot;
let modalCam = { radius: 4.8, theta: Math.PI / 4, phi: Math.PI / 2.6 };

function initModalScene() {
  const viewportEl = $('viewport3d');
  modalScene = new THREE.Scene();
  lightScene(modalScene);

  const grid3d = new THREE.GridHelper(6, 24, 0x2a3550, 0x1a2136);
  grid3d.position.y = -1.25;
  modalScene.add(grid3d);

  modalSensorGroup = createSensorMeshGroup();
  modalScene.add(modalSensorGroup);

  modalTrailGeometry = new THREE.BufferGeometry();
  const trailMaterial = new THREE.LineBasicMaterial({ color: 0xf5c451, transparent: true, opacity: 0.85 });
  modalTrailLine = new THREE.Line(modalTrailGeometry, trailMaterial);
  modalScene.add(modalTrailLine);

  modalTrailDot = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 12), new THREE.MeshBasicMaterial({ color: 0xf5c451 }));
  modalScene.add(modalTrailDot);

  modalCamera = new THREE.PerspectiveCamera(50, 1, 0.05, 1000);
  updateModalCameraPosition();

  modalRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  modalRenderer.setPixelRatio(window.devicePixelRatio);
  viewportEl.appendChild(modalRenderer.domElement);

  let dragging = false, lastX = 0, lastY = 0;
  modalRenderer.domElement.addEventListener('pointerdown', (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; });
  window.addEventListener('pointerup', () => dragging = false);
  window.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    modalCam.theta -= (e.clientX - lastX) * 0.006;
    modalCam.phi = Math.min(Math.max(modalCam.phi - (e.clientY - lastY) * 0.006, 0.2), Math.PI - 0.2);
    lastX = e.clientX; lastY = e.clientY;
    updateModalCameraPosition();
  });
  modalRenderer.domElement.addEventListener('wheel', (e) => {
    modalCam.radius = Math.min(Math.max(modalCam.radius + e.deltaY * 0.003, 1.5), 12);
    updateModalCameraPosition();
    e.preventDefault();
  }, { passive: false });
}

function updateModalCameraPosition() {
  modalCamera.position.set(
    modalCam.radius * Math.sin(modalCam.phi) * Math.sin(modalCam.theta),
    modalCam.radius * Math.cos(modalCam.phi),
    modalCam.radius * Math.sin(modalCam.phi) * Math.cos(modalCam.theta)
  );
  modalCamera.lookAt(AVATAR_LOOK_TARGET);
}

function resizeModalRenderer() {
  const viewportEl = $('viewport3d');
  const w = viewportEl.clientWidth, h = viewportEl.clientHeight;
  if (!w || !h) return;
  modalCamera.aspect = w / h;
  modalCamera.updateProjectionMatrix();
  modalRenderer.setSize(w, h);
}

function openModal(id) {
  if (!sensors.has(id)) return;
  modalSensorId = id;
  $('detailModal').hidden = false;

  if (!modalRenderer) initModalScene();
  resizeModalRenderer();

  const entry = sensors.get(id);
  entry.state.displayQuat.copy(entry.state.latestQuat);
  renderDetailStatus(entry);
}

function closeModal() {
  $('detailModal').hidden = true;
  modalSensorId = null;
}

function renderDetailStatus(entry) {
  $('detailName').textContent = entry.meta.name || entry.meta.id;
  const st = entry.meta.status || 'offline';
  const badge = $('detailStatus');
  badge.textContent = st === 'online' ? 'online' : st === 'connecting' ? 'conectando' : 'offline';
  badge.className = 'badge ' + st;
}

// ============================================================================
// PROCESSAMENTO DE UM PACOTE DE DADOS - roda o pipeline completo (leve +
// pesado) para QUALQUER sensor, sempre, ja que todos os cards ficam vivos
// simultaneamente na grade.
// ============================================================================
function applyIncomingData(sensorId, data, isLive) {
  const entry = sensors.get(sensorId) || ensureSensor({ id: sensorId, name: sensorId, status: 'online' });
  const { state } = entry;

  if (isLive) entry.meta.lastSeen = Date.now();

  const now = performance.now();
  state.lastPacketTime = now;
  state.packetTimes.push(now);
  if (state.packetTimes.length > 30) state.packetTimes.shift();

  // usa a aceleracao LINEAR (gravidade ja removida) - sem viés por
  // sentido do golpe (ver comentario em CONFIG.impactThresholdG)
  state.lastImpactG = Math.sqrt(data.lia.x ** 2 + data.lia.y ** 2 + data.lia.z ** 2) / 1000;

  updateOrientation(state, data.qua);
  updateIntegration(state, data);
  pushHistory(state, data);
  checkImpact(entry, data);
  renderTileMetrics(entry);

  if (sensorId === modalSensorId) {
    if (state.packetTimes.length > 1) {
      const span = (state.packetTimes[state.packetTimes.length - 1] - state.packetTimes[0]) / 1000;
      const hz = (state.packetTimes.length - 1) / span;
      $('rateText').textContent = `${hz.toFixed(0)} Hz`;
    }
    updateDom(data, state);
  }
}

// ============================================================================
// ORIENTACAO / INTEGRACAO (parametrizado por estado do sensor)
// ============================================================================
// Offset de montagem (calculado uma vez a partir de CONFIG.mountOffsetDeg):
// corrige a rotacao fixa introduzida por o sensor estar preso de lado no
// corpo, em vez de deitado nas costas. Ver comentario em CONFIG.
const mountOffsetInv = new THREE.Quaternion()
  .setFromEuler(new THREE.Euler(
    THREE.MathUtils.degToRad(CONFIG.mountOffsetDeg.x),
    THREE.MathUtils.degToRad(CONFIG.mountOffsetDeg.y),
    THREE.MathUtils.degToRad(CONFIG.mountOffsetDeg.z)
  ))
  .invert();

function updateOrientation(state, q) {
  const len = Math.sqrt(q.w * q.w + q.x * q.x + q.y * q.y + q.z * q.z) || 1;
  const w = q.w / len, x = q.x / len, y = q.y / len, z = q.z / len;
  const rv = CONFIG.remap(x, y, z);
  state.latestQuat.set(rv.x, rv.y, rv.z, w).normalize().multiply(mountOffsetInv);
}

function updateIntegration(state, data) {
  const nowT = data.t;
  if (state.lastDeviceT === null) { state.lastDeviceT = nowT; return; }
  let dt = (nowT - state.lastDeviceT) / 1000;
  state.lastDeviceT = nowT;
  if (dt <= 0 || dt > 0.5) return;

  const MG_TO_MS2 = 0.00980665;
  const ax = data.lia.x * MG_TO_MS2;
  const ay = data.lia.y * MG_TO_MS2;
  const az = data.lia.z * MG_TO_MS2;

  const rv = CONFIG.remap(ax, ay, az);
  const aWorldRaw = new THREE.Vector3(rv.x, rv.y, rv.z).applyQuaternion(state.latestQuat);

  // "parado" = sinal nao esta MUDANDO (jerk baixo), nao = sinal proximo
  // de zero. Assim, um vies constante nao impede a deteccao de parada.
  const jerk = state.lastRawAccelWorld ? aWorldRaw.distanceTo(state.lastRawAccelWorld) : 0;
  state.lastRawAccelWorld = aWorldRaw.clone();
  state.jerkEma = state.jerkEma * 0.8 + jerk * 0.2;

  if (state.jerkEma < CONFIG.zuptJerkThreshold) {
    if (state.belowThresholdSince === null) state.belowThresholdSince = performance.now();
    // aprende o vies atual (leitura "parada" = deveria ser zero real)
    state.accelBias.lerp(aWorldRaw, CONFIG.biasLearnRate);
    const stillMs = performance.now() - state.belowThresholdSince;
    if (stillMs > CONFIG.zuptHoldMs) state.velocity.set(0, 0, 0);
    // parado por tempo suficiente = volta a posicao/rastro pra origem
    // (ver comentario em CONFIG.autoResetPositionHoldMs)
    if (stillMs > CONFIG.autoResetPositionHoldMs && !state.autoResetDone) {
      state.position.set(0, 0, 0);
      state.trailPoints = [];
      state.autoResetDone = true;
    }
  } else {
    state.belowThresholdSince = null;
    state.autoResetDone = false;
  }

  const aWorld = aWorldRaw.clone().sub(state.accelBias);

  state.velocity.addScaledVector(aWorld, dt);
  state.velocity.multiplyScalar(CONFIG.velocityDamping);
  state.position.addScaledVector(state.velocity, dt);

  state.trailPoints.push(state.position.clone());
  if (state.trailPoints.length > CONFIG.trailMaxPoints) state.trailPoints.shift();
}

function resetTrajectory() {
  const entry = sensors.get(modalSensorId);
  if (!entry) return;
  entry.state.velocity.set(0, 0, 0);
  entry.state.position.set(0, 0, 0);
  entry.state.trailPoints = [];
  entry.state.accelBias.set(0, 0, 0);
  entry.state.belowThresholdSince = null;
  entry.state.autoResetDone = false;
}

// ============================================================================
// PAINEL DE DETALHES DO MODAL (DOM)
// ============================================================================
function updateDom(d, state) {
  $('valYaw').textContent = fmt(d.eul.yaw, 1) + '°';
  $('valPitch').textContent = fmt(d.eul.pitch, 1) + '°';
  $('valRoll').textContent = fmt(d.eul.roll, 1) + '°';
  $('valQw').textContent = fmt(d.qua.w, 3);
  $('valQx').textContent = fmt(d.qua.x, 3);
  $('valQy').textContent = fmt(d.qua.y, 3);
  $('valQz').textContent = fmt(d.qua.z, 3);

  $('valAccX').textContent = d.acc.x; $('valAccY').textContent = d.acc.y; $('valAccZ').textContent = d.acc.z;
  $('valLiaX').textContent = d.lia.x; $('valLiaY').textContent = d.lia.y; $('valLiaZ').textContent = d.lia.z;

  const liaMagG = Math.sqrt(d.lia.x ** 2 + d.lia.y ** 2 + d.lia.z ** 2) / 1000;
  $('valImpactG').textContent = fmt(liaMagG, 2) + ' g';

  $('valGyrX').textContent = fmt(d.gyr.x, 1); $('valGyrY').textContent = fmt(d.gyr.y, 1); $('valGyrZ').textContent = fmt(d.gyr.z, 1);

  $('valVelX').textContent = fmt(state.velocity.x); $('valVelY').textContent = fmt(state.velocity.y); $('valVelZ').textContent = fmt(state.velocity.z);
  $('valPosX').textContent = fmt(state.position.x); $('valPosY').textContent = fmt(state.position.y); $('valPosZ').textContent = fmt(state.position.z);
  $('valSpeed').textContent = fmt(state.velocity.length()) + ' m/s';

  $('valMagX').textContent = d.mag.x; $('valMagY').textContent = d.mag.y; $('valMagZ').textContent = d.mag.z;
  $('valGrvX').textContent = d.grv.x; $('valGrvY').textContent = d.grv.y; $('valGrvZ').textContent = d.grv.z;

  setCalBar($('calSys'), d.cal.sys);
  setCalBar($('calGyro'), d.cal.gyro);
  setCalBar($('calAcc'), d.cal.acc);
  setCalBar($('calMag'), d.cal.mag);

  $('valTemp').textContent = d.temp + ' °C';
}

function setCalBar(barEl, value) {
  const pct = (value / 3) * 100;
  const bar = barEl.querySelector('i');
  bar.style.width = pct + '%';
  bar.style.background = value >= 3 ? 'var(--good)' : value >= 1 ? 'var(--warn)' : 'var(--bad)';
}

// ============================================================================
// DETECCAO DE IMPACTO / GOLPE - roda para TODOS os sensores (log global)
// ============================================================================
function checkImpact(entry, d) {
  const g = Math.sqrt(d.lia.x ** 2 + d.lia.y ** 2 + d.lia.z ** 2) / 1000;
  const above = g >= CONFIG.impactThresholdG;

  if (above && !entry.state.lastImpactAboveThreshold) {
    logImpact(entry, g);
    if (entry.meta.id === modalSensorId) flashViewport();
  }
  entry.state.lastImpactAboveThreshold = above;
}

function logImpact(entry, g) {
  const log = $('impactLog');
  const empty = log.querySelector('.empty');
  if (empty) empty.remove();

  const el = document.createElement('div');
  el.className = 'entry';
  const time = new Date().toLocaleTimeString('pt-BR', { hour12: false });
  el.innerHTML = `<div class="row1"><span class="sensorName">${entry.meta.name || entry.meta.id}</span><span class="g">${g.toFixed(2)} g</span></div><span class="time">${time}</span>`;
  log.insertBefore(el, log.firstChild);

  while (log.children.length > 40) log.removeChild(log.lastChild);
}

function flashViewport() {
  const el = $('impactFlash');
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

// ============================================================================
// HISTORICO (alimenta o mini-grafico do card E os 9 graficos do modal)
// ============================================================================
function pushHistory(state, d) {
  const now = performance.now();
  state.history.push({
    t: now,
    accX: d.acc.x / 1000, accY: d.acc.y / 1000, accZ: d.acc.z / 1000,
    liaX: d.lia.x / 1000, liaY: d.lia.y / 1000, liaZ: d.lia.z / 1000,
    gyrX: d.gyr.x, gyrY: d.gyr.y, gyrZ: d.gyr.z,
    yaw: d.eul.yaw, pitch: d.eul.pitch, roll: d.eul.roll,
    magX: d.mag.x, magY: d.mag.y, magZ: d.mag.z,
    velX: state.velocity.x, velY: state.velocity.y, velZ: state.velocity.z,
    posX: state.position.x, posY: state.position.y, posZ: state.position.z,
    speed: state.velocity.length(),
    accMag: Math.sqrt(d.acc.x ** 2 + d.acc.y ** 2 + d.acc.z ** 2) / 1000,
    gyrMag: Math.sqrt(d.gyr.x ** 2 + d.gyr.y ** 2 + d.gyr.z ** 2),
    temp: d.temp,
  });
  const cutoff = now - CONFIG.chartHistorySeconds * 1000;
  while (state.history.length && state.history[0].t < cutoff) state.history.shift();
}

// --------------------------------------------------------------- mini-chart
function drawMiniChart(entry) {
  const { chartCanvas, chartCtx } = entry.tile;
  const w = chartCanvas.clientWidth, h = chartCanvas.clientHeight;
  if (!w || !h) return;
  if (chartCanvas.width !== w) chartCanvas.width = w;
  if (chartCanvas.height !== h) chartCanvas.height = h;

  const history = entry.state.history;
  chartCtx.clearRect(0, 0, w, h);
  if (history.length < 2) return;

  const now = performance.now();
  const t0 = now - CONFIG.chartHistorySeconds * 1000;
  const span = now - t0;

  const drawSeries = (key, transform, min, max, color) => {
    chartCtx.beginPath();
    chartCtx.strokeStyle = color;
    chartCtx.lineWidth = 1.3;
    let first = true;
    history.forEach((p) => {
      const raw = transform ? transform(p) : p[key];
      const v = Math.min(Math.max(raw, min), max);
      const x = ((p.t - t0) / span) * w;
      const y = h - ((v - min) / (max - min)) * h;
      if (first) { chartCtx.moveTo(x, y); first = false; } else { chartCtx.lineTo(x, y); }
    });
    chartCtx.stroke();
  };

  drawSeries('accMag', null, 0, 6, '#3fd0ff');
  drawSeries('gyrMag', (p) => p.gyrMag / 100, 0, 6, '#ff5c7a');
}

// --------------------------------------------------------- grade de 9 graficos (modal)
const CHART_DEFS = [
  { id: 'accel', title: 'Aceleração', unit: 'g', min: -4, max: 4,
    series: [{ key: 'accX', label: 'X', color: '#3fd0ff' }, { key: 'accY', label: 'Y', color: '#f5c451' }, { key: 'accZ', label: 'Z', color: '#35d68b' }] },
  { id: 'lia', title: 'Aceleração Linear', unit: 'g', min: -3, max: 3,
    series: [{ key: 'liaX', label: 'X', color: '#3fd0ff' }, { key: 'liaY', label: 'Y', color: '#f5c451' }, { key: 'liaZ', label: 'Z', color: '#35d68b' }] },
  { id: 'gyro', title: 'Giroscópio', unit: '°/s', min: -500, max: 500,
    series: [{ key: 'gyrX', label: 'X', color: '#3fd0ff' }, { key: 'gyrY', label: 'Y', color: '#f5c451' }, { key: 'gyrZ', label: 'Z', color: '#35d68b' }] },
  { id: 'orient', title: 'Orientação', unit: '°', min: -180, max: 180,
    series: [{ key: 'yaw', label: 'Yaw', color: '#3fd0ff' }, { key: 'pitch', label: 'Pitch', color: '#f5c451' }, { key: 'roll', label: 'Roll', color: '#35d68b' }] },
  { id: 'mag', title: 'Magnetômetro', unit: 'µT', min: -100, max: 100,
    series: [{ key: 'magX', label: 'X', color: '#3fd0ff' }, { key: 'magY', label: 'Y', color: '#f5c451' }, { key: 'magZ', label: 'Z', color: '#35d68b' }] },
  { id: 'vel', title: 'Velocidade (estimada)', unit: 'm/s', min: -4, max: 4,
    series: [{ key: 'velX', label: 'X', color: '#3fd0ff' }, { key: 'velY', label: 'Y', color: '#f5c451' }, { key: 'velZ', label: 'Z', color: '#35d68b' }, { key: 'speed', label: '|v|', color: '#ff5c7a' }] },
  { id: 'pos', title: 'Posição (estimada)', unit: 'm', min: -2, max: 2,
    series: [{ key: 'posX', label: 'X', color: '#3fd0ff' }, { key: 'posY', label: 'Y', color: '#f5c451' }, { key: 'posZ', label: 'Z', color: '#35d68b' }] },
  { id: 'overview', title: 'Impacto & Rotação (magnitude)', unit: 'g · °/s', min: 0, max: 6,
    series: [{ key: 'accMag', label: 'Acc |a|', color: '#3fd0ff' }, { key: 'gyrMagScaled', label: 'Gyro/100', color: '#ff5c7a' }] },
  { id: 'temp', title: 'Temperatura', unit: '°C', min: 15, max: 45,
    series: [{ key: 'temp', label: 'Temp', color: '#f5c451' }] },
];

const modalCharts = [];

function buildModalChartPanels() {
  const grid = $('chartsGrid');
  CHART_DEFS.forEach((def) => {
    const panel = document.createElement('div');
    panel.className = 'chartpanel';

    const head = document.createElement('div');
    head.className = 'chartHead';
    head.innerHTML = `<h3>${def.title}</h3><span class="chartUnit">${def.unit}</span>`;
    panel.appendChild(head);

    const canvas = document.createElement('canvas');
    panel.appendChild(canvas);

    const legend = document.createElement('div');
    legend.className = 'chartlegend';
    const legendEls = {};
    def.series.forEach((s) => {
      const span = document.createElement('span');
      span.className = 'lg';
      span.style.setProperty('--dotcolor', s.color);
      span.innerHTML = `${s.label}<span class="val">--</span>`;
      legendEls[s.key] = span.querySelector('.val');
      legend.appendChild(span);
    });
    panel.appendChild(legend);

    grid.appendChild(panel);
    modalCharts.push({ def, canvas, ctx: canvas.getContext('2d'), legendEls });
  });
}
buildModalChartPanels();

function drawModalCharts() {
  const entry = sensors.get(modalSensorId);
  if (!entry || entry.state.history.length < 2) return;
  const history = entry.state.history;

  const now = performance.now();
  const t0 = now - CONFIG.chartHistorySeconds * 1000;
  const span = now - t0;

  modalCharts.forEach(({ def, canvas, ctx, legendEls }) => {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    ctx.clearRect(0, 0, w, h);

    const zeroY = h - ((0 - def.min) / (def.max - def.min)) * h;
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath(); ctx.moveTo(0, zeroY); ctx.lineTo(w, zeroY); ctx.stroke();

    def.series.forEach((s) => {
      ctx.beginPath();
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.5;
      let first = true;
      history.forEach((p) => {
        const raw = s.key === 'gyrMagScaled' ? p.gyrMag / 100 : p[s.key];
        const v = Math.min(Math.max(raw, def.min), def.max);
        const x = ((p.t - t0) / span) * w;
        const y = h - ((v - def.min) / (def.max - def.min)) * h;
        if (first) { ctx.moveTo(x, y); first = false; } else { ctx.lineTo(x, y); }
      });
      ctx.stroke();

      const last = history[history.length - 1];
      const lastRaw = s.key === 'gyrMagScaled' ? last.gyrMag / 100 : last[s.key];
      if (legendEls[s.key]) legendEls[s.key].textContent = fmt(lastRaw, 2);
    });
  });
}

// ============================================================================
// LOOP DE RENDERIZACAO - unico rAF, atualiza todos os tiles + o modal (se
// aberto). E aqui que a suavizacao (slerp) e o resize continuo acontecem,
// desacoplados da taxa de chegada de pacotes -> visual sempre fluido.
// ============================================================================
let lastFrameTime = performance.now();
let fpsSmoothed = 0;

function animate() {
  requestAnimationFrame(animate);

  const now = performance.now();
  const frameDt = now - lastFrameTime;
  lastFrameTime = now;
  fpsSmoothed = fpsSmoothed * 0.9 + (1000 / frameDt) * 0.1;
  $('fpsText').textContent = fpsSmoothed.toFixed(0);

  sensors.forEach((entry) => {
    const { state, tile } = entry;

    // suavizacao da orientacao - roda sempre, alimenta tile + view unificada + modal
    state.displayQuat.slerp(state.latestQuat, CONFIG.quatSlerpFactor);

    if (activeView === 'grid') {
      tile.sensorGroup.quaternion.copy(state.displayQuat);

      const w = tile.viewportEl.clientWidth, h = tile.viewportEl.clientHeight;
      if (w && h && (tile.lastSize.w !== w || tile.lastSize.h !== h)) {
        tile.lastSize = { w, h };
        tile.camera.aspect = w / h;
        tile.camera.updateProjectionMatrix();
        tile.renderer.setSize(w, h);
      }
      if (w && h) tile.renderer.render(tile.scene, tile.camera);

      drawMiniChart(entry);
      renderTileMetrics(entry);
    }
  });

  if (activeView === 'comparison') {
     renderUnifiedFrame(); 
     drawComparisonCharts();
  }

  if (modalSensorId && modalRenderer) {
    const entry = sensors.get(modalSensorId);
    if (entry) {
      const { state } = entry;
      if (state.lastPacketTime) {
        $('latText').textContent = Math.max(0, now - state.lastPacketTime).toFixed(0) + ' ms';
      }

      modalSensorGroup.quaternion.copy(state.displayQuat);

      if (state.trailVisible && state.trailPoints.length > 1) {
        modalTrailLine.visible = true;
        modalTrailGeometry.setFromPoints(state.trailPoints);
        const last = state.trailPoints[state.trailPoints.length - 1];
        modalTrailDot.position.copy(last);
        modalTrailDot.visible = true;
        modalSensorGroup.position.copy(last);
      } else {
        modalTrailLine.visible = state.trailPoints.length > 1;
        modalTrailDot.visible = false;
      }
    }

    resizeModalRenderer();
    modalRenderer.render(modalScene, modalCamera);
    drawModalCharts();
  }
}
animate();

// ============================================================================
// CONTROLES DE UI
// ============================================================================
$('btnResetTraj').addEventListener('click', resetTrajectory);
$('btnToggleTrail').addEventListener('click', (e) => {
  const entry = sensors.get(modalSensorId);
  if (!entry) return;
  entry.state.trailVisible = !entry.state.trailVisible;
  e.target.textContent = entry.state.trailVisible ? 'Ocultar rastro' : 'Mostrar rastro';
});
$('btnCloseModal').addEventListener('click', closeModal);
$('detailModalBackdrop').addEventListener('click', closeModal);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('detailModal').hidden) closeModal();
});

// ============================================================================
// ESTADO INICIAL DA GRADE (placeholder ate a lista chegar do servidor)
// ============================================================================
(function initEmptyGrid() {
  const grid = $('tilesGrid');
  const empty = document.createElement('div');
  empty.className = 'navEmpty';
  empty.textContent = 'Aguardando lista de sensores do servidor...';
  grid.appendChild(empty);
})();

// ============================================================================
// GRADE COMPARATIVA - Gráficos Sobrepostos (Ação vs Resposta: sensor_1 vs sensor_2)
// ============================================================================
const comparisonCharts = [];

function buildComparisonChartPanels() {
  const grid = $('comparisonChartsGrid');
  if (!grid) return;
  grid.innerHTML = '';

  CHART_DEFS.forEach((def) => {
    const panel = document.createElement('div');
    panel.className = 'chartpanel';

    const head = document.createElement('div');
    head.className = 'chartHead';
    head.innerHTML = `<h3>${def.title}</h3><span class="chartUnit">${def.unit}</span>`;
    panel.appendChild(head);

    const canvas = document.createElement('canvas');
    panel.appendChild(canvas);

    const legend = document.createElement('div');
    legend.className = 'chartlegend';
    legend.innerHTML = `
      <span class="lg" style="--dotcolor: #3fd0ff;">sensor_1 (Ação) <span class="val" id="comp_${def.id}_s1">--</span></span>
      <span class="lg" style="--dotcolor: #ff5c7a;">sensor_2 (Resposta) <span class="val" id="comp_${def.id}_s2">--</span></span>
    `;
    panel.appendChild(legend);

    grid.appendChild(panel);
    comparisonCharts.push({ def, canvas, ctx: canvas.getContext('2d'), elS1: $(`comp_${def.id}_s1`), elS2: $(`comp_${def.id}_s2`) });
  });
}

// Inicializa os painéis comparativos
buildComparisonChartPanels();

function drawComparisonCharts() {
  if (activeView !== 'comparison') return;

  const s1Entry = sensors.get('sensor_1');
  const s2Entry = sensors.get('sensor_2');

  const now = performance.now();
  const t0 = now - CONFIG.chartHistorySeconds * 1000;
  const span = now - t0;

  comparisonCharts.forEach(({ def, canvas, ctx, elS1, elS2 }) => {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    ctx.clearRect(0, 0, w, h);

    const zeroY = h - ((0 - def.min) / (def.max - def.min)) * h;
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath(); ctx.moveTo(0, zeroY); ctx.lineTo(w, zeroY); ctx.stroke();

    const drawSensorSeries = (history, color, seriesKey) => {
      if (!history || history.length < 2) return;
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6;
      let first = true;
      history.forEach((p) => {
        const raw = seriesKey === 'gyrMagScaled' ? p.gyrMag / 100 : p[seriesKey];
        const v = Math.min(Math.max(raw, def.min), def.max);
        const x = ((p.t - t0) / span) * w;
        const y = h - ((v - def.min) / (def.max - def.min)) * h;
        if (first) { ctx.moveTo(x, y); first = false; } else { ctx.lineTo(x, y); }
      });
      ctx.stroke();
    };

    const key = def.series[0].key;
    if (s1Entry && s1Entry.state.history.length > 0) {
      drawSensorSeries(s1Entry.state.history, '#3fd0ff', key);
      const last = s1Entry.state.history[s1Entry.state.history.length - 1];
      const val = key === 'gyrMagScaled' ? last.gyrMag / 100 : last[key];
      if (elS1) elS1.textContent = fmt(val, 2);
    }
    if (s2Entry && s2Entry.state.history.length > 0) {
      drawSensorSeries(s2Entry.state.history, '#ff5c7a', key);
      const last = s2Entry.state.history[s2Entry.state.history.length - 1];
      const val = key === 'gyrMagScaled' ? last.gyrMag / 100 : last[key];
      if (elS2) elS2.textContent = fmt(val, 2);
    }
  });
}

// ============================================================================
// INICIO
// ============================================================================
connectServer();
