// UUIDs definidos no código da ESP32 (Sensor de Ação / Hub)
const SERVICE_UUID = "4fafc201-1fb5-459e-8fcc-c5c9c331914b";
const CHARACTERISTIC_UUID = "beb5483e-36e1-4688-b7f5-ea07361b26aae";

let bluetoothDevice = null;
let bluetoothCharacteristic = null;

// Elementos da interface (ajuste os IDs conforme o seu HTML)
const connectButton = document.getElementById('connectBtn');
const statusDiv = document.getElementById('status');

connectButton.addEventListener('click', async () => {
    try {
        statusDiv.textContent = 'A procurar dispositivos BLE...';
        
        // Solicitar o dispositivo via Web Bluetooth (filtra pelo nome ou serviço)
        bluetoothDevice = await navigator.bluetooth.requestDevice({
            filters: [{ name: 'JudoHub' }],
            optionalServices: [SERVICE_UUID]
        });

        bluetoothDevice.addEventListener('gattserverdisconnected', onDisconnected);

        statusDiv.textContent = 'A conectar ao Servidor GATT...';
        const server = await bluetoothDevice.gatt.connect();

        statusDiv.textContent = 'A procurar serviço...';
        const service = await server.getPrimaryService(SERVICE_UUID);

        statusDiv.textContent = 'A procurar característica...';
        bluetoothCharacteristic = await service.getCharacteristic(CHARACTERISTIC_UUID);

        // Ativar notificações para receber os dados em tempo real
        await bluetoothCharacteristic.startNotifications();
        bluetoothCharacteristic.addEventListener('characteristicvaluechanged', handleDataNotifications);

        statusDiv.textContent = 'Conectado com sucesso ao Hub de Judo!';
        connectButton.textContent = 'Desconectar';
    } catch (error) {
        console.error('Erro na conexão Bluetooth:', error);
        statusDiv.textContent = 'Erro: ' + error.message;
    }
});

// Função que processa cada pacote recebido da ESP32
function handleDataNotifications(event) {
    const value = event.target.value;
    
    // O pacote recebido é um ArrayBuffer correspondente à struct_message (tamanho exato)
    // Vamos desestruturar com base nos tipos definidos no C++
    const decoder = new TextDecoder('utf-8');
    
    // Exemplo de leitura da struct binária em JavaScript:
    const id = decoder.decode(value.buffer.slice(0, 10)).replace(/\0/g, ''); // char id[10]
    
    const dataView = new DataView(value.buffer);
    let offset = 10; // após o id

    const qx = dataView.getFloat32(offset, true); offset += 4;
    const qy = dataView.getFloat32(offset, true); offset += 4;
    const qz = dataView.getFloat32(offset, true); offset += 4;
    const qw = dataView.getFloat32(offset, true); offset += 4;

    const accX = dataView.getInt16(offset, true); offset += 2;
    const accY = dataView.getInt16(offset, true); offset += 2;
    const accZ = dataView.getInt16(offset, true); offset += 2;

    const liaX = dataView.getInt16(offset, true); offset += 2;
    const liaY = dataView.getInt16(offset, true); offset += 2;
    const liaZ = dataView.getInt16(offset, true); offset += 2;

    const gyrX = dataView.getFloat32(offset, true); offset += 4;
    const gyrY = dataView.getFloat32(offset, true); offset += 4;
    const gyrZ = dataView.getFloat32(offset, true); offset += 4;

    const yaw   = dataView.getFloat32(offset, true); offset += 4;
    const pitch = dataView.getFloat32(offset, true); offset += 4;
    const roll  = dataView.getFloat32(offset, true); offset += 4;

    // Atualizar o ecrã consoante seja o sensor_1 ou o sensor_2
    if (id === 'sensor_1') {
        // Atualizar elementos visuais para o Sensor de Ação
        // console.log("Sensor 1 Yaw:", yaw);
    } else if (id === 'sensor_2') {
        // Atualizar elementos visuais para o Sensor de Resposta
        // console.log("Sensor 2 Yaw:", yaw);
    }
}

function onDisconnected() {
    statusDiv.textContent = 'Desconectado do Hub.';
    connectButton.textContent = 'Conectar Bluetooth';
}