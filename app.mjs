import {RemoteClient, validateConfig, validateImage} from './protocol.mjs';
import {ControlPanel} from './control-panel.mjs';
const $ = id => document.getElementById(id);
let config, mqttClient, remote, firmware, uploading = false, verifying = false, paused = false;
let logs = [], logKeys = new Set(), receiveChain = Promise.resolve();
let controlling = false;

// ================= TRẠNG THÁI KẾT NỐI USB SERIAL & PYTHON BRIDGE =================
let directPort = null;
let directReader = null;
let directKeepReading = false;
let directWriteChain = Promise.resolve();
let bridgeWs = null;
let bridgeConnected = false;
let bridgeComPort = null;
let lastSerialAt = 0;
let serialFirmware = 'ESP32-S3 (Qua cổng USB Serial)';

const serialTelemetry = {
  running: false,
  mode: 0,
  q: [60, 100, 300],
  t: [60, 60, 60],
  q_pv: 0,
  duty: 0,
  pid: false,
  remaining_s: 0,
  manual: false,
  pending_mode: 0,
  hmi_pending: false,
  keys: 0,
  y1: false,
  y2: false,
  y3: false,
  rssi: -60
};

function isSerialActive() {
  return Boolean(directPort) || Boolean(bridgeConnected && bridgeComPort);
}

function getSerialStatusObject() {
  return {
    type: 'status',
    firmware: serialFirmware,
    session: 'usb-serial-session',
    control: 1,
    control_token: '0123456789abcdef0123456789abcdef',
    idle: !serialTelemetry.running && !serialTelemetry.manual,
    ota: false,
    telemetry: serialTelemetry
  };
}

const panel = new ControlPanel(handleDeviceControl);
const notice = (text, error = false) => {
  if ($('notice')) {
    $('notice').textContent = text;
    $('notice').classList.toggle('error', error);
  }
};

function appendLogLine(text, dedupPrefix = 'serial') {
  if (typeof text !== 'string' || !text.trim()) return;
  const key = dedupPrefix + ':' + text + ':' + (dedupPrefix === 'serial' ? Date.now() + '-' + Math.random() : '');
  if (dedupPrefix !== 'serial' && logKeys.has(key)) return;
  logKeys.add(key);
  logs.push({key, text});
  if (logs.length > 1000) logKeys.delete(logs.shift().key);
  renderLogs();
}

function renderLogs() {
  if (paused || !$('logs')) return;
  $('logs').textContent = logs.length ? logs.map(entry => entry.text).join('\n') : 'Đang chờ log từ ESP32…';
  if ($('log-count')) $('log-count').textContent = `${logs.length} dòng`;
  if ($('follow')?.checked) $('logs').scrollTop = $('logs').scrollHeight;
}

function handleEvent(event) {
  if (event.type === 'log' && typeof event.text === 'string') {
    const key = (remote?.status?.session ?? '') + ':' + event.text;
    if (logKeys.has(key)) return;
    logKeys.add(key);
    logs.push({key, text: event.text});
    if (logs.length > 1000) logKeys.delete(logs.shift().key);
    renderLogs();
  }
  if (event.type === 'status') {
    if ($('firmware-label')) $('firmware-label').textContent = event.firmware;
    renderState();
  }
}

function renderState() {
  const remoteFresh = Boolean(remote?.connected && Date.now() - remote.lastStatusAt < 12000);
  const usbActive = isSerialActive();

  if ($('usb-badge')) {
    if (directPort) {
      $('usb-badge').textContent = 'USB: Đã kết nối trực tiếp';
      $('usb-badge').className = 'badge online';
    } else if (bridgeConnected && bridgeComPort) {
      $('usb-badge').textContent = `USB Bridge: ${bridgeComPort}`;
      $('usb-badge').className = 'badge online';
    } else {
      $('usb-badge').textContent = 'USB: Chưa kết nối';
      $('usb-badge').className = 'badge';
    }
  }

  const state = remoteFresh
    ? (remote.status.ota ? 'Đang cập nhật' : remote.status.idle ? 'Sẵn sàng cập nhật' : 'Thiết bị đang vận hành')
    : usbActive
      ? (serialTelemetry.running ? `Đang chạy Mode ${serialTelemetry.mode} (USB)` : serialTelemetry.manual ? 'Đang phát xung PWM thủ công (USB)' : 'Kết nối USB sẵn sàng')
      : 'Chưa nhận phản hồi ESP32';

  if ($('device-state')) $('device-state').textContent = state;
  if ($('connection-badge')) {
    $('connection-badge').textContent = remoteFresh
      ? 'ESP32 trực tuyến'
      : mqttClient?.connected
        ? 'Đã nối broker · chờ ESP32'
        : usbActive
          ? 'ESP32 qua cổng USB'
          : 'Chưa kết nối';
    $('connection-badge').className = 'badge' + (remoteFresh ? (remote.status.ota ? ' busy' : ' online') : usbActive ? ' online' : '');
  }

  if (usbActive && !remoteFresh) {
    if ($('device-label') && ($('device-label').textContent === '—' || !$('device-label').textContent)) {
      $('device-label').textContent = directPort ? 'Cổng USB trực tiếp (Web Serial)' : `Python Bridge (${bridgeComPort})`;
    }
    if ($('firmware-label') && ($('firmware-label').textContent === '—' || !$('firmware-label').textContent)) {
      $('firmware-label').textContent = serialFirmware;
    }
  }

  if ($('upload')) $('upload').disabled = !remoteFresh || !remote.status.idle || remote.status.ota || !firmware || uploading || controlling;
  if ($('config-file')) $('config-file').disabled = uploading || controlling;
  if ($('firmware-file')) $('firmware-file').disabled = uploading || controlling;
  if ($('connect')) $('connect').disabled = !config || !!mqttClient || uploading || controlling;
  if ($('disconnect')) $('disconnect').disabled = !mqttClient || uploading || controlling;
  if ($('cancel')) $('cancel').disabled = !uploading || verifying;

  if (remoteFresh || (remote?.connected && mqttClient?.connected)) {
    panel.render(remote?.status, {
      fresh: remoteFresh,
      connected: Boolean(remote?.connected && mqttClient?.connected),
      busy: uploading || controlling,
      lastStatusAt: remote?.lastStatusAt
    });
  } else if (usbActive) {
    panel.render(getSerialStatusObject(), {
      fresh: true,
      connected: true,
      busy: controlling,
      lastStatusAt: lastSerialAt || Date.now()
    });
  } else {
    panel.render(remote?.status, {
      fresh: false,
      connected: false,
      busy: uploading || controlling,
      lastStatusAt: remote?.lastStatusAt
    });
  }
}

async function handleDeviceControl(action, values) {
  const remoteFresh = Boolean(remote?.connected && Date.now() - remote.lastStatusAt < 12000);
  if (remoteFresh && remote && !uploading && !controlling) {
    controlling = true;
    panel.message('Đang chờ ESP32 xác nhận lệnh…');
    renderState();
    try {
      await remote.control(action, values);
      panel.message(action === 'save' ? `ESP32 đã lưu Q${values.mode}/T${values.mode}. Đang chờ trạng thái và đồng bộ HMI.`
        : action === 'start' ? `ESP32 đã nhận lệnh Mode ${values.mode}. Chờ trạng thái xác nhận bơm chạy.`
        : 'ESP32 đã nhận lệnh dừng bơm theo X4/B4. Chờ trạng thái xác nhận.');
    } catch (error) {
      panel.message(error.message, true);
    } finally {
      controlling = false;
      renderState();
    }
    return;
  }

  if (isSerialActive() && !controlling) {
    controlling = true;
    renderState();
    try {
      if (action === 'stop') {
        await sendSerialCommand('stop');
        serialTelemetry.running = false;
        serialTelemetry.manual = false;
        serialTelemetry.mode = 0;
        serialTelemetry.duty = 0;
        panel.message('Đã gửi lệnh dừng bơm (stop) qua cổng USB Serial.');
      } else if (action === 'start') {
        await sendSerialCommand(`mode${values.mode}`);
        serialTelemetry.running = true;
        serialTelemetry.manual = false;
        serialTelemetry.mode = values.mode;
        panel.message(`Đã gửi lệnh chạy Mode ${values.mode} qua cổng USB Serial.`);
      } else if (action === 'save') {
        serialTelemetry.q[values.mode - 1] = values.q;
        serialTelemetry.t[values.mode - 1] = values.minutes;
        await sendSerialCommand(`set ${values.mode} ${values.q} ${values.minutes}`);
        panel.message(`Đã gửi lệnh lưu Q${values.mode}=${values.q} L/h, T${values.mode}=${values.minutes} phút qua cổng USB Serial.`);
      }
      setTimeout(() => sendSerialCommand('status', true), 300);
    } catch (error) {
      panel.message(error.message || 'Lỗi gửi lệnh qua cổng USB.', true);
    } finally {
      controlling = false;
      renderState();
    }
  }
}

// ================= PARSER LOG & TELEMETRY TỪ CỔNG USB SERIAL =================
function parseSerialLine(line) {
  const s = line.trim();
  if (!s) return;
  lastSerialAt = Date.now();

  if (s.startsWith('[TELEM]')) {
    const jsonPart = s.slice(7).trim();
    try {
      const parsed = JSON.parse(jsonPart);
      Object.assign(serialTelemetry, parsed);
      renderState();
    } catch {}
    return;
  }

  // Parse phiên bản FW: [FW] pump-flow-...
  const fwMatch = s.match(/\[FW\]\s+([^\s|]+)/);
  if (fwMatch) {
    serialFirmware = fwMatch[1];
    if ($('firmware-label')) $('firmware-label').textContent = serialFirmware;
  }

  // Parse [TEST PWM 12-BIT 1kHz] GPIO 14 Duty = 1000/4095 (24.4%) | Q_pv = 215.0 L/h
  const pwmTestMatch = s.match(/Duty\s*=\s*(\d+)\/4095.*Q_pv\s*=\s*([\d.]+)/i);
  if (pwmTestMatch) {
    serialTelemetry.manual = true;
    serialTelemetry.running = false;
    serialTelemetry.duty = Number(pwmTestMatch[1]);
    serialTelemetry.q_pv = Number(pwmTestMatch[2]);
  }

  if (s.includes('DA TAT XUNG GPIO 14')) {
    serialTelemetry.manual = false;
    serialTelemetry.duty = 0;
  }

  // Parse [RUN] Mode 1 bat dau! Q=120 L/h, T=60 min, Duty=867
  const modeStartMatch = s.match(/\[RUN\]\s*Mode\s*(\d)\s*bat dau!\s*Q=([\d.]+)\s*L\/h,\s*T=([\d.]+)\s*min,\s*Duty=(\d+)/i);
  if (modeStartMatch) {
    const m = Number(modeStartMatch[1]);
    serialTelemetry.running = true;
    serialTelemetry.manual = false;
    serialTelemetry.mode = m;
    if (m >= 1 && m <= 3) {
      serialTelemetry.q[m - 1] = Number(modeStartMatch[2]);
      serialTelemetry.t[m - 1] = Number(modeStartMatch[3]);
    }
    serialTelemetry.duty = Number(modeStartMatch[4]);
  }

  // Parse [FLOW PI] Q_s:100.0 Q_p:98.5 ... Duty:850
  const flowPiMatch = s.match(/\[FLOW PI\].*Q_p:([\d.]+).*Duty:(\d+)/);
  if (flowPiMatch) {
    serialTelemetry.q_pv = Number(flowPiMatch[1]);
    serialTelemetry.duty = Number(flowPiMatch[2]);
    serialTelemetry.running = true;
  }

  // Parse [RUN] Tu Q_setpoint(40001) = 100.0 L/h, Q_pv = 99.2 -> duty=850
  const runLineMatch = s.match(/Q_setpoint\(4000(\d)\)\s*=\s*([\d.]+)\s*L\/h,\s*Q_pv\s*=\s*([\d.]+)\s*->\s*duty=(\d+)/);
  if (runLineMatch) {
    const m = Number(runLineMatch[1]);
    serialTelemetry.running = true;
    serialTelemetry.mode = m;
    serialTelemetry.q_pv = Number(runLineMatch[3]);
    serialTelemetry.duty = Number(runLineMatch[4]);
  }

  if (s.includes('[X4]') || s.includes('Nhan lenh DUNG BOM') || s.includes('ket thuc chu trinh')) {
    serialTelemetry.running = false;
    serialTelemetry.mode = 0;
    serialTelemetry.duty = 0;
  }

  appendLogLine(s, 'serial');
  renderState();
}

// ================= WEB SERIAL API (CHẾ ĐỘ 1 - KẾT NỐI TRỰC TIẾP USB) =================
function setDirectUi(connected, msg, isError = false) {
  const btn = $('btn-direct-connect');
  if (btn) {
    btn.textContent = connected ? '❌ Ngắt Kết Nối USB' : '🔌 Chọn Cổng USB & Kết Nối';
    btn.classList.toggle('connected', connected);
  }
  const dn = $('direct-notice');
  if (dn && msg) {
    dn.textContent = msg;
    dn.style.color = isError ? '#ae3030' : connected ? '#13744d' : '';
  }
  renderState();
}

async function writeDirectSerial(text) {
  if (!directPort || !directPort.writable) return false;
  const runWrite = async () => {
    let writer = null;
    try {
      writer = directPort.writable.getWriter();
      const data = new TextEncoder().encode(text);
      await writer.write(data);
      return true;
    } catch (err) {
      appendLogLine(`!! [USB DIRECT] Lỗi gửi: ${err.message}`, 'serial');
      return false;
    } finally {
      if (writer) {
        try { writer.releaseLock(); } catch {}
      }
    }
  };
  directWriteChain = directWriteChain.then(runWrite, runWrite);
  return directWriteChain;
}

async function disconnectDirectSerial() {
  directKeepReading = false;
  const portToClose = directPort;
  const readerToCancel = directReader;
  directPort = null;
  directReader = null;
  try {
    if (readerToCancel) {
      await readerToCancel.cancel().catch(() => {});
      try { readerToCancel.releaseLock(); } catch {}
    }
  } catch {}
  try {
    await directWriteChain.catch(() => {});
  } catch {}
  try {
    if (portToClose) {
      await portToClose.close().catch(() => {});
    }
  } catch {}
  setDirectUi(false, 'Đã ngắt kết nối cổng USB trực tiếp.');
  appendLogLine('## [USB DIRECT] Đã đóng cổng USB an toàn.', 'serial');
}

async function readDirectLoop(port) {
  let buffer = '';
  const decoder = new TextDecoder('utf-8');
  while (port && port.readable && directKeepReading) {
    let reader = null;
    try {
      reader = port.readable.getReader();
      directReader = reader;
      while (directKeepReading) {
        const {value, done} = await reader.read();
        if (done) break;
        if (value) {
          buffer += decoder.decode(value, {stream: true});
          let idx;
          while ((idx = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, idx).replace(/\r$/, '');
            buffer = buffer.slice(idx + 1);
            parseSerialLine(line);
          }
        }
      }
    } catch (err) {
      if (directKeepReading) {
        appendLogLine(`!! [USB DIRECT] Mất kết nối đọc: ${err.message}`, 'serial');
      }
      break;
    } finally {
      if (reader) {
        try { reader.releaseLock(); } catch {}
      }
      if (directReader === reader) directReader = null;
    }
  }
  if (directPort === port) {
    directPort = null;
    setDirectUi(false, 'Cổng USB đã ngắt kết nối.');
  }
}

async function toggleDirectSerial() {
  if (directPort) {
    await disconnectDirectSerial();
    return;
  }
  if (!navigator.serial) {
    if ($('file-protocol-warning')) $('file-protocol-warning').hidden = false;
    setDirectUi(false, 'Trình duyệt không hỗ trợ Web Serial ở chế độ file://. Hãy mở qua GitHub Pages hoặc Mo_Giao_Dien_Web.bat!', true);
    return;
  }
  try {
    const baudRate = Number($('direct-baud')?.value || 115200);
    const port = await navigator.serial.requestPort();
    await port.open({baudRate});
    directPort = port;
    directKeepReading = true;
    lastSerialAt = Date.now();
    setDirectUi(true, `Đang kết nối trực tiếp USB (${baudRate} baud)`);
    appendLogLine(`## [USB DIRECT] Đã mở cổng USB thành công (${baudRate} baud)`, 'serial');
    readDirectLoop(port);
    setTimeout(() => {
      sendSerialCommand('ver', true);
      sendSerialCommand('status', true);
    }, 600);
  } catch (err) {
    if (err?.name !== 'NotFoundError') {
      setDirectUi(false, `Lỗi mở cổng USB: ${err.message}`, true);
      appendLogLine(`!! [USB DIRECT] Lỗi mở cổng: ${err.message}`, 'serial');
    }
  }
}

// ================= PYTHON WEBSOCKET BRIDGE (DỰ PHÒNG: ws://127.0.0.1:8765) =================
function sendBridge(payload) {
  if (bridgeWs && bridgeWs.readyState === WebSocket.OPEN) {
    bridgeWs.send(JSON.stringify(payload));
    return true;
  }
  return false;
}

function connectBridgeWs() {
  if (typeof WebSocket === 'undefined') return;
  if (window.location.protocol === 'https:') return; // Trên HTTPS ưu tiên Web Serial trực tiếp + MQTT WSS
  try {
    bridgeWs = new WebSocket('ws://127.0.0.1:8765');
  } catch {
    return;
  }
  bridgeWs.onopen = () => {
    bridgeConnected = true;
    if ($('bridge-ws-status')) {
      $('bridge-ws-status').textContent = 'WS: đã nối Bridge';
      $('bridge-ws-status').className = 'badge online';
    }
    sendBridge({cmd: 'list'});
  };
  bridgeWs.onclose = () => {
    bridgeConnected = false;
    bridgeComPort = null;
    if ($('bridge-ws-status')) {
      $('bridge-ws-status').textContent = 'WS: chưa chạy Bridge';
      $('bridge-ws-status').className = 'badge';
    }
    renderState();
    setTimeout(connectBridgeWs, 3500);
  };
  bridgeWs.onerror = () => {};
  bridgeWs.onmessage = event => {
    try {
      const m = JSON.parse(event.data);
      if (m.type === 'ports' && $('bridge-port')) {
        const sel = $('bridge-port');
        sel.textContent = '';
        for (const p of (m.ports || [])) {
          const opt = document.createElement('option');
          opt.value = p.port;
          opt.textContent = `${p.port} — ${p.desc}`;
          if (m.current === p.port) opt.selected = true;
          sel.appendChild(opt);
        }
      } else if (m.type === 'status') {
        bridgeComPort = m.connected ? (m.port || 'COM') : null;
        if ($('bridge-com-status')) {
          $('bridge-com-status').textContent = m.connected ? `COM: ${m.port} (${m.baud} baud)` : 'COM: chưa kết nối';
        }
        if (m.msg) appendLogLine(`## [BRIDGE] ${m.msg}`, 'serial');
        if (m.connected) {
          setTimeout(() => {
            sendSerialCommand('ver', true);
            sendSerialCommand('status', true);
          }, 600);
        }
        renderState();
      } else if (m.type === 'data' && typeof m.line === 'string') {
        parseSerialLine(m.line);
      }
    } catch {}
  };
}

async function sendSerialCommand(cmdText, quiet = false) {
  const clean = String(cmdText || '').trim();
  if (!clean) return false;
  if (directPort && directPort.writable) {
    const ok = await writeDirectSerial(clean + '\n');
    if (!quiet) appendLogLine(ok ? `>> ${clean}` : `!! Lỗi gửi: ${clean}`, 'serial');
    return ok;
  }
  if (sendBridge({cmd: 'send', data: clean})) {
    if (!quiet) appendLogLine(`>> ${clean}`, 'serial');
    return true;
  }
  if (!quiet) {
    appendLogLine('!! Chưa kết nối cổng USB (Hãy bấm "Chọn Cổng USB & Kết Nối" ở Chế độ 1 trước).', 'serial');
  }
  return false;
}

// ================= KẾT NỐI TỪ XA MQTT & OTA (GIỮ NGUYÊN 100% CHUẨN CŨ) =================
function disconnect() {
  remote?.disconnect();
  mqttClient?.end(true);
  mqttClient = null;
  remote = null;
  renderState();
}

$('config-file')?.addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 8192) throw new Error();
    const next = validateConfig(JSON.parse(await file.text()));
    disconnect();
    config = next;
    panel.reset();
    logs = [];
    logKeys.clear();
    renderLogs();
    $('device-label').textContent = config.device_id;
    $('pairing-label').textContent = `Đã ghép cặp: ${config.device_id}`;
    notice('Đã đọc cấu hình. Bấm Kết nối để nhận log.');
    renderState();
  } catch {
    notice('Không đọc được cấu hình. Hãy chọn đúng client.json được tạo cùng firmware của thiết bị.', true);
  }
});

$('connect')?.addEventListener('click', () => {
  if (!config || !globalThis.mqtt || !crypto.subtle) {
    notice('Trình duyệt cần HTTPS và hỗ trợ Web Crypto. Kiểm tra đã tải đủ các file trang web.', true);
    return;
  }
  notice('Đang kết nối và chờ phản hồi đã xác thực từ ESP32…');
  const client = mqtt.connect(config.websocket_url, {
    protocolVersion: 4,
    clean: true,
    clientId: 'web-' + crypto.randomUUID(),
    keepalive: 30,
    reconnectPeriod: 2000,
    connectTimeout: 15000,
    queueQoSZero: false
  });
  mqttClient = client;
  const current = new RemoteClient(config, (topic, data) => new Promise((resolve, reject) => {
    if (!client.connected) {
      reject(new Error('Đã mất kết nối tới broker.'));
      return;
    }
    client.publish(topic, data, {qos: 0, retain: false}, error => error ? reject(error) : resolve());
  }), handleEvent);
  remote = current;
  client.on('connect', () => {
    if (remote !== current) return;
    current.connected = true;
    client.subscribe(current.eventTopic, {qos: 1}, error => {
      if (remote !== current) return;
      if (error) {
        notice('Không đăng ký nhận được dữ liệu từ broker.', true);
        return;
      }
      current.refresh()
        .then(() => notice('Đã nhận phản hồi từ ESP32. Log sẽ tự cập nhật.'))
        .catch(() => notice('Broker đã kết nối. Chưa nhận phản hồi: kiểm tra ESP32 đã nạp đúng firmware, WiFi và file ghép cặp.'));
    });
    renderState();
  });
  client.on('message', (topic, data, packet) => {
    if (remote !== current || topic !== current.eventTopic || packet.retain) return;
    receiveChain = receiveChain.then(() => current.receive(new Uint8Array(data))).catch(() => {});
  });
  client.on('close', () => {
    if (remote === current) {
      current.disconnect();
      renderState();
    }
  });
  client.on('error', () => {
    if (remote === current) notice('Chưa kết nối được broker. Trang sẽ tự thử lại.', true);
  });
  renderState();
});

$('disconnect')?.addEventListener('click', () => {
  disconnect();
  notice('Đã ngắt kết nối.');
});

$('firmware-file')?.addEventListener('change', async event => {
  firmware = null;
  const file = event.target.files[0];
  if (!file) {
    renderState();
    return;
  }
  try {
    if (file.size > 4 * 1024 * 1024) throw new Error('File quá lớn cho phân vùng ứng dụng.');
    const data = new Uint8Array(await file.arrayBuffer());
    validateImage(data);
    firmware = data;
    $('file-label').textContent = `${file.name} · ${(file.size / 1024).toFixed(1)} KB`;
    $('upload-status').textContent = 'File hợp lệ về loại chip. ESP32 sẽ kiểm tra toàn bộ image sau khi truyền.';
  } catch (error) {
    $('file-label').textContent = 'File chưa hợp lệ.';
    $('upload-status').textContent = error.message;
  }
  renderState();
});

$('upload')?.addEventListener('click', async () => {
  if (!remote || !firmware || uploading) return;
  uploading = true;
  verifying = false;
  renderState();
  $('progress').value = 0;
  $('percent').textContent = '0%';
  $('upload-status').textContent = 'Đang xác nhận thiết bị đã dừng và bắt đầu truyền…';
  try {
    await remote.upload(firmware, (done, total) => {
      const percent = Math.floor(done / total * 100);
      $('progress').value = percent;
      $('percent').textContent = percent + '%';
      if (done === total) {
        verifying = true;
        renderState();
      }
      $('upload-status').textContent = percent === 100
        ? 'Đã truyền đủ dữ liệu. Đang chờ ESP32 xác minh firmware…'
        : `Đã xác nhận ${(done / 1024).toFixed(0)} / ${(total / 1024).toFixed(0)} KB. Giữ trang đang mở.`;
    }, phase => {
      const messages = {
        checking: 'Đang xác nhận thiết bị đã dừng. Chờ tối đa 20 giây vì ESP32 có thể đang chờ phản hồi HMI…',
        starting: 'Đang chờ ESP32 xác nhận bắt đầu OTA. Chưa truyền dữ liệu firmware…',
        transferring: 'ESP32 đã nhận phiên OTA. Đang truyền firmware…',
        verifying: 'Đã truyền đủ dữ liệu. Đang chờ ESP32 xác minh firmware…',
        cancelling: 'Đang chờ ESP32 kết thúc phiên vừa hủy trước khi cho phép thử lại…'
      };
      $('upload-status').textContent = messages[phase];
      if (phase === 'verifying' || phase === 'cancelling') verifying = true;
      renderState();
    });
    $('upload-status').textContent = 'ESP32 đã xác minh firmware và chuẩn bị khởi động lại. Chờ trạng thái trực tuyến trở lại.';
    notice('Cập nhật đã được ESP32 xác nhận thành công.');
    firmware = null;
    $('firmware-file').value = '';
  } catch (error) {
    const prefix = error.phase === 'checking' ? 'Chưa bắt đầu nạp: ' : '';
    $('upload-status').textContent = prefix + error.message + (error.phase === 'verifying'
      ? ' Kiểm tra phiên bản khi ESP32 kết nối lại để xác nhận kết quả.' : '');
  } finally {
    uploading = false;
    verifying = false;
    renderState();
  }
});

$('cancel')?.addEventListener('click', () => remote?.cancel());
$('pause')?.addEventListener('click', () => {
  paused = !paused;
  $('pause').textContent = paused ? 'Tiếp tục hiển thị' : 'Tạm dừng hiển thị';
  renderLogs();
});
$('clear')?.addEventListener('click', () => {
  logs = [];
  logKeys.clear();
  renderLogs();
});
$('download')?.addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([logs.map(entry => entry.text).join('\n') + '\n'], {type: 'text/plain;charset=utf-8'}));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'esp32-logs.txt';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// ================= SỰ KIỆN NÚT USB SERIAL & TEST PWM =================
if (typeof window !== 'undefined' && window.location?.protocol === 'file:') {
  if ($('file-protocol-warning')) $('file-protocol-warning').hidden = false;
}

$('btn-direct-connect')?.addEventListener('click', toggleDirectSerial);
$('bridge-refresh')?.addEventListener('click', () => sendBridge({cmd: 'list'}));
$('bridge-connect')?.addEventListener('click', () => {
  const port = $('bridge-port')?.value;
  const baud = Number($('bridge-baud')?.value || 115200);
  if (port) sendBridge({cmd: 'connect', port, baud});
});
$('bridge-disconnect')?.addEventListener('click', () => sendBridge({cmd: 'disconnect'}));

function updatePwmPreview(val) {
  const v = Math.max(0, Math.min(4095, Number(val) || 0));
  if ($('pwm-slider')) $('pwm-slider').value = String(v);
  if ($('pwm-input')) $('pwm-input').value = String(v);
  if ($('pwm-slider-label')) {
    const pct = (v / 4095 * 100).toFixed(1);
    $('pwm-slider-label').textContent = `Duty: ${v} / 4095 (${pct}%)`;
  }
}

$('pwm-slider')?.addEventListener('input', e => updatePwmPreview(e.target.value));
$('pwm-input')?.addEventListener('input', e => updatePwmPreview(e.target.value));
$('btn-send-pwm')?.addEventListener('click', () => {
  const v = Math.max(0, Math.min(4095, Number($('pwm-input')?.value) || 0));
  sendSerialCommand(`xung ${v}`);
});
$('btn-stop-pwm')?.addEventListener('click', () => {
  updatePwmPreview(0);
  sendSerialCommand('0');
});

for (const btn of document.querySelectorAll('[data-serial-cmd]')) {
  btn.addEventListener('click', () => {
    const cmdVal = btn.getAttribute('data-serial-cmd');
    if (/^\d+$/.test(cmdVal)) updatePwmPreview(Number(cmdVal));
    else if (cmdVal?.endsWith('%')) {
      const pct = parseFloat(cmdVal);
      if (Number.isFinite(pct)) updatePwmPreview(Math.round(pct / 100 * 4095));
    }
    sendSerialCommand(cmdVal);
  });
}

$('btn-send-custom')?.addEventListener('click', () => {
  const inp = $('serial-custom-input');
  if (inp && inp.value.trim()) {
    sendSerialCommand(inp.value.trim());
    inp.value = '';
  }
});
$('serial-custom-input')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('btn-send-custom')?.click();
  }
});

connectBridgeWs();
setInterval(renderState, 1000);
setInterval(() => {
  if (remote?.connected && !uploading && !controlling) remote.refresh().catch(() => {});
  if (isSerialActive() && !controlling) sendSerialCommand('status', true);
}, 5000);
window.addEventListener('beforeunload', event => {
  if (uploading) {
    event.preventDefault();
    event.returnValue = '';
  }
});
renderState();
