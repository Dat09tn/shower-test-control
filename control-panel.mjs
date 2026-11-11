const $ = id => document.getElementById(id);
const number = new Intl.NumberFormat('vi-VN', {maximumFractionDigits:1});
export function readTelemetry(status) {
  const t = status?.telemetry;
  if (status?.control !== 1 || !/^[a-f0-9]{32}$/i.test(status.control_token ?? '') || !t ||
      !Array.isArray(t.q) || !Array.isArray(t.t) || t.q.length !== 3 || t.t.length !== 3 ||
      ![...t.q, ...t.t, t.q_pv, t.duty, t.mode, t.remaining_s].every(Number.isFinite) ||
      typeof t.running !== 'boolean' || typeof t.manual !== 'boolean' || t.mode < 0 || t.mode > 3 ||
      t.duty < 0 || t.duty > 4095) return null;
  return t;
}
export function duration(seconds) {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}
export class ControlPanel {
  constructor(onAction) {
    this.dirty = new Set();
    for (let mode = 1; mode <= 3; ++mode) {
      $(`settings-${mode}`).addEventListener('submit', event => {
        event.preventDefault();
        onAction('save', {mode, q:Number($(`q-${mode}`).value), minutes:Number($(`t-${mode}`).value)});
      });
      $(`start-${mode}`).addEventListener('click', () => onAction('start', {mode}));
      for (const prefix of ['q', 't']) $(`${prefix}-${mode}`).addEventListener('input', () => {
        this.dirty.add(mode); $(`saved-${mode}`).textContent = 'Có thay đổi chưa lưu.';
      });
    }
    $('control-stop').addEventListener('click', () => onAction('stop', {}));
  }
  reset() {
    this.dirty.clear();
    for (let mode = 1; mode <= 3; ++mode) { $(`q-${mode}`).value = ''; $(`t-${mode}`).value = ''; }
    this.message('Chờ kết nối ESP32 hỗ trợ điều khiển.');
  }
  message(text, error = false) {
    $('control-notice').textContent = text;
    $('control-notice').classList.toggle('error', error);
  }
  render(status, {fresh, connected, busy, lastStatusAt}) {
    const t = readTelemetry(status), ready = !!t && fresh && !status.ota && !busy;
    const stopped = !!t && !t.running && !t.manual && !t.pending_mode;
    $('control-availability').textContent = !connected ? 'Chờ kết nối thiết bị.' : !status ? 'Đang chờ dữ liệu từ ESP32…'
      : !t ? 'Cần nạp firmware remote4-control để sử dụng bảng điều khiển.'
      : !fresh ? `Dữ liệu cuối đã ${Math.floor((Date.now() - lastStatusAt) / 1000)} giây; chờ phản hồi mới để điều khiển.`
      : status.ota ? 'Đang OTA · các nút điều khiển được khóa.'
      : t.hmi_pending ? 'Q/T đã lưu trên ESP32 · đang chờ đồng bộ HMI.' : 'Đang hiển thị trạng thái ESP32 gửi về.';
    $('pump-state').textContent = !t ? '—' : t.pending_mode ? `Chờ chạy Mode ${t.pending_mode}`
      : t.manual ? 'PWM thủ công' : t.running ? `Đang chạy Mode ${t.mode}` : 'Bơm đang dừng';
    $('flow-value').textContent = t ? `${number.format(t.q_pv)} L/h` : '—';
    $('remaining-value').textContent = t ? duration(t.remaining_s) : '—';
    $('pwm-value').textContent = t ? `${t.duty} / 4095` : '—';
    $('wifi-value').textContent = t && Number.isFinite(t.rssi) ? `${t.rssi} dBm` : '—';
    $('control-stop').disabled = !ready || stopped;
    for (let mode = 1; mode <= 3; ++mode) {
      const active = !!t && t.running && t.mode === mode;
      $(`mode-card-${mode}`).classList.toggle('active', active);
      $(`mode-state-${mode}`).textContent = active ? 'Đang chạy' : t?.pending_mode === mode ? 'Đã nhận lệnh' : 'Chờ';
      $(`start-${mode}`).disabled = !ready || !stopped;
      $(`start-${mode}`).setAttribute('aria-pressed', String(active));
      $(`save-${mode}`).disabled = !ready || !stopped;
      $(`key-${mode}`).classList.toggle('pressed', !!t && !!(t.keys & (1 << (mode - 1))));
      $(`key-${mode}`).textContent = `X${mode}: ${t ? t.keys & (1 << (mode - 1)) ? 'đang nhấn' : 'nhả' : '—'}`;
      for (const prefix of ['q', 't']) $(`${prefix}-${mode}`).disabled = !ready || !stopped;
      if (!t) { $(`saved-${mode}`).textContent = 'Chưa có dữ liệu Q/T.'; continue; }
      const q = $(`q-${mode}`), minutes = $(`t-${mode}`);
      if (Number(q.value) === t.q[mode - 1] && Number(minutes.value) === t.t[mode - 1]) this.dirty.delete(mode);
      if (!this.dirty.has(mode)) {
        if (document.activeElement !== q) q.value = t.q[mode - 1];
        if (document.activeElement !== minutes) minutes.value = t.t[mode - 1];
      }
      $(`saved-${mode}`).textContent = `Trên ESP32: Q${mode}=${number.format(t.q[mode - 1])} L/h · T${mode}=${number.format(t.t[mode - 1])} phút`
        + (this.dirty.has(mode) ? ' · Có thay đổi chưa lưu.' : '');
    }
    $('key-4').textContent = `X4: ${t ? t.keys & 8 ? 'đang nhấn' : 'nhả' : '—'}`;
    $('key-4').classList.toggle('pressed', !!t && !!(t.keys & 8));
    for (const output of ['y1', 'y2', 'y3']) {
      $(output).textContent = !t ? '—' : t[output] ? 'Bật' : 'Tắt';
      $(output).classList.toggle('on', !!t?.[output]);
    }
  }
}
