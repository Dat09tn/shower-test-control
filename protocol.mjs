const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const CHUNK_SIZE = 1024;
export const hex = data => Array.from(data, b => b.toString(16).padStart(2, '0')).join('');
export function unhex(value, bytes) {
  if (typeof value !== 'string' || !new RegExp(`^[0-9a-f]{${bytes * 2}}$`, 'i').test(value)) throw new Error('Dữ liệu ghép cặp không hợp lệ.');
  return Uint8Array.from(value.match(/../g), b => parseInt(b, 16));
}
export function validateConfig(config) {
  if (config.version !== 1 || !/^[a-z0-9-]{1,40}$/.test(config.device_id)) throw new Error('File cấu hình thiết bị không hợp lệ.');
  unhex(config.key_hex, 32);
  const url = new URL(config.websocket_url);
  if (url.protocol !== 'wss:' || url.username || url.password) throw new Error('Kết nối cần dùng WSS có xác minh TLS.');
  return config;
}
export class Cipher {
  constructor(key) { this.key = crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt', 'decrypt']); }
  async seal(topic, plain) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM', iv, additionalData:encoder.encode(topic)}, await this.key, plain));
    const packet = new Uint8Array(13 + encrypted.length);
    packet[0] = 1; packet.set(iv, 1); packet.set(encrypted, 13);
    return packet;
  }
  async open(topic, packet) {
    if (packet.length <= 29 || packet[0] !== 1) throw new Error('Gói tin không hợp lệ.');
    return new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM', iv:packet.slice(1, 13), additionalData:encoder.encode(topic)}, await this.key, packet.slice(13)));
  }
}
export function validateImage(image, capacity = 4 * 1024 * 1024) {
  if (!(image instanceof Uint8Array) || image.length < 288 || image.length > capacity ||
      image[0] !== 0xe9 || image[12] !== 9 || image[13] !== 0 ||
      new DataView(image.buffer, image.byteOffset, image.byteLength).getUint32(32, true) !== 0xabcd5432) {
    throw new Error('Cần firmware.bin của ứng dụng ESP32-S3, đúng dung lượng OTA; không dùng bootloader hoặc merged.bin.');
  }
}
export class RemoteClient {
  constructor(config, publish, onEvent = () => {}, options = {}) {
    validateConfig(config);
    this.cipher = new Cipher(unhex(config.key_hex, 32));
    this.commandTopic = `pump-remote/v1/${config.device_id}/cmd`;
    this.eventTopic = `pump-remote/v1/${config.device_id}/event`;
    this.publish = publish; this.onEvent = onEvent;
    this.timeout = options.timeout ?? 5000; this.retries = options.retries ?? 5;
    // remote1 can spend roughly 10 seconds in Modbus timeouts before returning
    // to its MQTT loop. Once BEGIN is accepted, its OTA guard skips Modbus.
    this.readyTimeout = options.readyTimeout ?? options.timeout ?? 20000;
    this.status = null; this.lastStatusAt = 0; this.waiters = new Set();
    this.seen = new Set(); this.busy = false; this.controlBusy = false; this.cancelled = false;
    this.connected = true;
  }
  async receive(packet) {
    const nonce = hex(packet.slice(1, 13));
    if (this.seen.has(nonce)) return;
    let event;
    try { event = JSON.parse(decoder.decode(await this.cipher.open(this.eventTopic, packet))); }
    catch { return; } // Shared broker traffic and forged messages are ignored.
    if (!Number.isFinite(event.ts) || Math.abs(Date.now() / 1000 - event.ts) > 60) return;
    this.seen.add(nonce);
    if (this.seen.size > 2048) this.seen.delete(this.seen.values().next().value);
    if (event.type === 'status') {
      try { unhex(event.session, 16); unhex(event.token, 16); } catch { return; }
      if (this.status?.session === event.session && event.uptime < this.status.uptime) return;
      this.status = event; this.lastStatusAt = Date.now();
    }
    for (const waiter of [...this.waiters]) waiter(event);
    this.onEvent(event);
  }
  async send(payload) {
    if (!this.connected) throw new Error('Đã mất kết nối tới broker.');
    await this.publish(this.commandTopic, await this.cipher.seal(this.commandTopic, payload));
  }
  waitFor(predicate, payload, signal, timeout = this.timeout) {
    return new Promise((resolve, reject) => {
      let finished = false;
      const cleanup = () => { clearTimeout(timer); this.waiters.delete(listener); signal?.removeEventListener('abort', abort); };
      const done = (error, value) => {
        if (finished) return; finished = true; cleanup(); error ? reject(error) : resolve(value);
      };
      const listener = event => { try { if (predicate(event)) done(null, event); } catch (error) { done(error); } };
      const abort = () => done(new Error('Đã hủy cập nhật.'));
      const timer = setTimeout(() => done(new Error('Quá thời gian chờ phản hồi từ ESP32.')), timeout);
      this.waiters.add(listener);
      signal?.addEventListener('abort', abort, {once:true});
      if (signal?.aborted) { abort(); return; }
      this.send(payload).catch(error => done(error));
    });
  }
  async exchange(payload, transfer, session, offset, complete, signal, timeout = this.timeout) {
    const predicate = event => {
      if (event.type !== 'ack' || event.transfer !== transfer || event.session !== session) return false;
      if (event.state === 'error') throw new Error(`ESP32 từ chối: ${event.message}`);
      return complete ? event.state === 'complete' && event.offset === offset : event.state === 'receiving' && event.offset === offset;
    };
    for (let i = 0; i < this.retries; ++i) {
      try { return await this.waitFor(predicate, payload, signal, timeout); }
      catch (error) {
        if (signal?.aborted || !this.connected || !error.message.startsWith('Quá thời gian') || i === this.retries - 1) throw error;
      }
    }
  }
  async refresh(signal) {
    return this.waitFor(event => event.type === 'status', new Uint8Array([5]), signal, this.readyTimeout);
  }
  cancel() { this.abortController?.abort(); }
  disconnect() { this.connected = false; this.cancel(); }
  async control(action, {mode = 0, q = 0, minutes = 0} = {}) {
    if (this.busy || this.controlBusy) throw new Error('Đang xử lý một thao tác khác.');
    const opcode = {start:1, stop:2, save:3}[action];
    if (!opcode || (action !== 'stop' && (!Number.isInteger(mode) || mode < 1 || mode > 3)) ||
        (action === 'save' && (!Number.isInteger(q) || q < 40 || q > 500 || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440))) {
      throw new Error('Q phải là số nguyên 40–500 L/h; T là số nguyên 1–1440 phút.');
    }
    this.controlBusy = true;
    try {
      const status = await this.refresh();
      if (status.control !== 1) throw new Error('Cần nạp firmware remote4-control để dùng điều khiển và Q/T.');
      if (status.ota) throw new Error('Đang OTA; chờ cập nhật kết thúc trước khi điều khiển.');
      const id = crypto.getRandomValues(new Uint8Array(16)), request = hex(id);
      const payload = new Uint8Array(59), view = new DataView(payload.buffer);
      payload[0] = 6; payload.set(unhex(status.session, 16), 1); payload.set(id, 17);
      payload.set(unhex(status.control_token, 16), 33);
      view.setUint32(49, Math.floor(Date.now() / 1000)); payload[53] = opcode;
      payload[54] = action === 'stop' ? 0 : mode;
      view.setUint16(55, action === 'save' ? q : 0); view.setUint16(57, action === 'save' ? minutes : 0);
      const messages = {
        stop_first:'Dừng bơm và PWM thủ công trước khi chạy mode hoặc sửa Q/T.',
        command_pending:'ESP32 đang thực hiện lệnh trước. Chờ trạng thái mới.',
        ota_busy:'ESP32 đang OTA; chưa thực hiện lệnh điều khiển.',
        expired:'Lệnh đã quá hạn. Kiểm tra giờ máy tính và trạng thái trước khi thử lại.',
        stale_token:'Trạng thái đã thay đổi hoặc có trình duyệt khác gửi lệnh. Kiểm tra lại trước khi bấm.',
        invalid_settings:'Q/T trên ESP32 chưa hợp lệ. Lưu Q/T trước khi chạy.',
        invalid_command:'ESP32 từ chối lệnh không hợp lệ.', request_conflict:'Mã lệnh bị trùng với nội dung khác.'
      };
      const predicate = event => {
        if (event.type !== 'control_ack' || event.session !== status.session || event.request !== request) return false;
        if (event.ok !== true) throw new Error(messages[event.message] ?? 'ESP32 từ chối lệnh điều khiển.');
        return true;
      };
      for (let attempt = 0; attempt < 2; ++attempt) {
        try { return await this.waitFor(predicate, payload, undefined, this.readyTimeout); }
        catch (error) {
          if (!error.message.startsWith('Quá thời gian') || !this.connected) throw error;
          if (attempt === 1) throw new Error('Chưa xác nhận kết quả lệnh. Kiểm tra trạng thái ESP32 trước khi bấm lại.');
        }
      }
    } finally { this.controlBusy = false; }
  }
  async upload(image, progress = () => {}, onPhase = () => {}) {
    if (this.busy || this.controlBusy) throw new Error('Đang có một thao tác khác.');
    validateImage(image);
    this.busy = true;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    const id = crypto.getRandomValues(new Uint8Array(16));
    const transfer = hex(id);
    let begun = false, committed = false, stage = 'checking', session;
    try {
      onPhase(stage);
      const status = await this.refresh(signal);
      if (status.ota) throw new Error('ESP32 đang có một phiên OTA. Chờ phiên đó kết thúc; nếu bên gửi đã ngắt, thiết bị tự hủy sau 60 giây không nhận thêm dữ liệu.');
      if (!status.idle) throw new Error('ESP32 đang vận hành. Dừng bơm và chờ van/bơm hồi tắt trước khi cập nhật.');
      session = status.session;
      validateImage(image, status.capacity);
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', image));
      const begin = new Uint8Array(85);
      begin[0] = 1; begin.set(unhex(status.session, 16), 1); begin.set(unhex(status.token, 16), 17);
      begin.set(id, 33); new DataView(begin.buffer).setUint32(49, image.length); begin.set(digest, 53);
      stage = 'starting'; onPhase(stage);
      begun = true;
      await this.exchange(begin, transfer, session, 0, false, signal, this.readyTimeout);
      stage = 'transferring'; onPhase(stage);
      for (let offset = 0; offset < image.length;) {
        const part = image.slice(offset, offset + CHUNK_SIZE);
        const chunk = new Uint8Array(21 + part.length);
        chunk[0] = 2; chunk.set(id, 1); new DataView(chunk.buffer).setUint32(17, offset); chunk.set(part, 21);
        await this.exchange(chunk, transfer, session, offset + part.length, false, signal);
        offset += part.length; progress(offset, image.length);
      }
      const commit = new Uint8Array(17); commit[0] = 3; commit.set(id, 1);
      stage = 'verifying'; onPhase(stage); committed = true;
      await this.exchange(commit, transfer, session, image.length, true, signal);
      return {sha256:hex(digest)};
    } catch (error) {
      error.phase = stage;
      if (begun && !committed && this.connected) {
        const abort = new Uint8Array(17); abort[0] = 4; abort.set(id, 1);
        try {
          onPhase('cancelling');
          if (error.message.startsWith('ESP32 từ chối:')) {
            // Firmware rejection paths have already stopped this transfer.
            await this.send(abort);
          } else {
            // Do not enable another upload while our previous ABORT is still
            // queued behind BEGIN/Modbus. Wait for this transfer's own reply.
            await this.waitFor(event => event.type === 'ack' && event.session === session &&
              event.transfer === transfer && event.state === 'error' && event.message === 'cancelled',
              abort, undefined, this.readyTimeout);
          }
          await this.refresh();
        } catch {} // Preserve the original failure if cleanup loses the network.
      }
      throw error;
    } finally { this.busy = false; this.abortController = null; }
  }
}
