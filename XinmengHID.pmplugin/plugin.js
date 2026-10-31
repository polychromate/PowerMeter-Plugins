var offlineAfterSilence = 300000;
var handshakeGrace = 60000;
var staleAfter = 120000;
var state = newState();
var handle = null;

function newState() {
  return {
    level: null,
    charging: false,
    lastReport: null,
    keyboardOnline: null,
    startedAt: Date.now(),
    receiverPID: 0
  };
}

function parseReport(data) {
  if (!data || data.length < 8 || data[0] !== 0x13) return { type: "ignored" };
  if (data.length > 8) {
    var sum = 0;
    for (var i = 0; i < data.length - 1; i++) sum = (sum + data[i]) & 0xFF;
    if (sum !== data[data.length - 1]) return { type: "ignored" };
  }
  if (data[5] === 0x02) return { type: "offline" };
  var status = data[7];
  if ([0x01, 0x10, 0x11].indexOf(status) < 0) return { type: "ignored" };
  var capacity = data[6];
  if (capacity < 1 || capacity > 100) return { type: "ignored" };
  return {
    type: "battery",
    level: capacity,
    charging: status === 0x10 || status === 0x11
  };
}

function applyReport(data) {
  var result = parseReport(data);
  if (result.type === "battery") {
    state.keyboardOnline = true;
    state.level = result.level;
    state.charging = result.charging;
    state.lastReport = Date.now();
  } else if (result.type === "offline") {
    state.keyboardOnline = false;
    state.lastReport = Date.now();
  }
}

function reading(now) {
  var lastActivity = state.lastReport === null ? state.startedAt : state.lastReport;
  var grace = state.lastReport === null ? handshakeGrace : offlineAfterSilence;
  var silent = now - lastActivity > grace;
  var offline = state.keyboardOnline === false;
  var disconnected = offline || silent;
  var detail = "厂商私有协议 0x13";
  if (offline) {
    detail = "接收器在线，键盘未连接（已关机或不在 2.4G 模式）";
  } else if (state.level === null) {
    detail = "已找到接收器，等待电量报文";
  }
  return {
    level: disconnected ? null : state.level,
    charging: disconnected ? false : state.charging,
    offline: offline,
    silent: silent,
    stale: !disconnected && state.level !== null && (state.lastReport === null || now - state.lastReport > staleAfter),
    disconnected: disconnected,
    detail: detail
  };
}

function ensureReceiver() {
  var devices = hid.listDevices({ vendorID: 0x3554, usagePage: 0xFF02 });
  if (devices.length === 0) {
    if (handle) hid.closeDevice(handle);
    handle = null;
    state = newState();
    return "";
  }
  var selected = devices[0];
  if (handle === selected.id) return "";
  if (handle) hid.closeDevice(handle);
  if (!hid.openDevice(selected.id)) {
    handle = null;
    return hid.status() || "无法打开新盟接收器";
  }
  handle = selected.id;
  state = newState();
  state.receiverPID = selected.productID || 0;
  return "";
}

function drainReports() {
  if (!handle) return;
  var reports = hid.takeReports(handle);
  for (var i = 0; i < reports.length; i++) applyReport(reports[i]);
}

function snapshot() {
  var error = ensureReceiver();
  if (!handle) return { devices: [], status: error };
  drainReports();

  var now = Date.now();
  var current = reading(now);
  if (current.disconnected) {
    var reason = current.offline
      ? "接收器在线，但键盘未连接（已关机或休眠），已从列表隐藏"
      : "接收器在线，但长时间没有电量报文，已从列表隐藏";
    return { devices: [], status: error || reason };
  }

  var extra = {
    "接收器": "VID 0x3554 PID 0x" + ("0000" + state.receiverPID.toString(16).toUpperCase()).slice(-4)
  };
  if (state.lastReport !== null) {
    var seconds = Math.max(0, Math.floor((now - state.lastReport) / 1000));
    extra["报文"] = seconds < 60 ? Math.max(seconds, 1) + " 秒前" : Math.floor(seconds / 60) + " 分钟前";
  }
  return {
    devices: [{
      id: "xinmeng-2.4g",
      name: "新盟键盘（2.4G）",
      kind: "keyboard",
      transport: "usb",
      level: current.level,
      charging: current.charging,
      connected: true,
      detail: current.detail,
      lastUpdate: state.lastReport || now,
      stale: current.stale,
      extra: extra,
      sourcePolicy: "preferPlugin"
    }],
    status: error
  };
}

function selfTest() {
  var errors = [];
  var online = parseReport([0x13, 0x0A, 0x01, 0x00, 0x04, 0x05, 0x63, 0x01]);
  if (online.type !== "battery" || online.level !== 99 || online.charging) errors.push("在线报文");
  var charging = parseReport([0x13, 0x0A, 0x01, 0x00, 0x04, 0x05, 0x64, 0x11]);
  if (charging.type !== "battery" || charging.level !== 100 || !charging.charging) errors.push("充电报文");
  var offline = parseReport([0x13, 0x0A, 0x01, 0x00, 0x04, 0x02, 0x01, 0x00]);
  if (offline.type !== "offline") errors.push("离线占位报文");
  var ignored = parseReport([0x13, 0x0A, 0x01, 0x00, 0x04, 0x05, 0x63, 0x00]);
  if (ignored.type !== "ignored") errors.push("无效状态报文");
  if (typeof hid === "undefined" || !Array.isArray(hid.listDevices({}))) errors.push("HID 桥 listDevices");
  if (!Array.isArray(hid.listDevices({ vendorID: 0x3554, usagePage: 0xFF02 }))) errors.push("HID 桥筛选");
  return errors;
}
