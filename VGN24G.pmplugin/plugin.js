// VGN 2.4G 键盘电量插件
//
// 设备：VGN S99 等使用 Telink / Evision 平台 2.4G 接收器的键盘
//       VID 0x320F、PID 0x5088（有线版是 0x5055，不在本插件范围）
//
// 协议（厂商私有通道，实机验证）：
//   接收器有 2 个 HID 接口，都报成标准键盘（page 0x0001 / usage 0x0006），
//   但其中一个是复合集合，包含厂商集合 page 0xFF1C / usage 0x92：
//     Report ID 4：Input 63 字节 + Output 63 字节（没有任何 Feature 报告）
//   电量必须"主机问一次、设备答一次"——接收器不主动推送：
//     发出 Output Report 4：00 00 1A 06 00 …（0x1A = GetBatterLevel）
//     回包 Input  Report 4：00 00 1A 06 00 00 00 <电量> <充电标志> …
//
// 两个实机踩过的坑：
//   1) macOS 的 IOHIDDeviceSetReport 要把 Report ID 放在数据首字节一起写（64 字节），
//      只写 63 字节载荷会被当成 Report 0，设备一律不理。
//   2) 回包会带回 Report ID（64 字节），解析前必须判断首字节是不是 0x04 再决定偏移。
//
// 安全边界：只发 0x1A 这一条只读查询，绝不发送任何写配置指令；
//          键盘休眠时接收器不会应答，此时按"未连接"处理，不显示陈旧读数。

var VID = 0x320F;
var PID = 0x5088;
var REPORT_ID = 0x04;
var CMD_BATTERY = 0x1A;
var CMD_TAIL = 0x06;
var FRAME_LEN = 64;

var QUERY_TIMEOUT_MS = 700;
var MIN_QUERY_GAP_MS = 1500;
var MAX_ATTEMPTS = 2;

var session = null;

function newSession(ids) {
  return {
    ids: ids,
    responder: null,
    level: null,
    charging: false,
    lastReplyAt: null,
    lastQueryAt: 0,
    attempts: 0
  };
}

function closeSession() {
  if (!session) return;
  for (var i = 0; i < session.ids.length; i++) hid.closeDevice(session.ids[i]);
  session = null;
}

// 64 字节写缓冲：首字节是 Report ID，命令码落在载荷第 3 字节（整体第 4 字节）
function buildRequest() {
  var frame = [];
  for (var i = 0; i < FRAME_LEN; i++) frame.push(0);
  frame[0] = REPORT_ID;
  frame[3] = CMD_BATTERY;
  frame[4] = CMD_TAIL;
  return frame;
}

// 解析回包；带不带 Report ID 都认。不是电量回包返回 null
function parseReply(raw) {
  if (!raw || raw.length < 10) return null;
  var base = raw[0] === REPORT_ID ? 1 : 0;
  if (raw.length < base + 9) return null;
  if (raw[base + 2] !== CMD_BATTERY) return null;
  var level = raw[base + 7];
  if (level < 0 || level > 100) return null;
  return { level: level, charging: raw[base + 8] !== 0 };
}

function ensureSession() {
  var devices = hid.listDevices({ vendorID: VID, productID: PID });
  if (devices.length === 0) {
    closeSession();
    return "未检测到 VGN 2.4G 接收器（VID 0x320F PID 0x5088），请确认接收器已插好";
  }

  var ids = [];
  var openError = "";
  for (var i = 0; i < devices.length; i++) {
    var id = devices[i].id;
    if (hid.openDevice(id)) {
      ids.push(id);
    } else if (!openError) {
      openError = hid.status() || "无法打开 VGN 接收器";
    }
  }
  if (ids.length === 0) {
    closeSession();
    return openError;
  }

  if (session && session.ids.length === ids.length) {
    var same = true;
    for (var k = 0; k < ids.length; k++) {
      if (session.ids[k] !== ids[k]) same = false;
    }
    if (same) return "";
  }

  closeSession();
  session = newSession(ids);
  return "";
}

// 向所有接口扇出查询，谁先答就用谁（两个接口的 VID/PID/usagePage 完全一样，无法预先区分）
function askBattery() {
  var frame = buildRequest();
  var targets = session.responder ? [session.responder] : session.ids;
  var sent = [];
  for (var i = 0; i < targets.length; i++) {
    hid.takeReports(targets[i]);
    if (hid.setReport({ id: targets[i], type: "output", reportID: REPORT_ID, data: frame })) {
      sent.push(targets[i]);
    }
  }
  if (sent.length === 0) return null;

  var deadline = Date.now() + QUERY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    hid.wait(10);
    for (var j = 0; j < sent.length; j++) {
      var reports = hid.takeReports(sent[j]);
      for (var r = 0; r < reports.length; r++) {
        var reading = parseReply(reports[r]);
        if (reading) return { id: sent[j], reading: reading };
      }
    }
  }
  return null;
}

function readBattery() {
  for (var attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    var hit = askBattery();
    if (hit) return hit;
  }
  return null;
}

function ago(now) {
  var seconds = Math.max(0, Math.floor((now - session.lastReplyAt) / 1000));
  if (seconds < 60) return Math.max(seconds, 1) + " 秒前";
  return Math.floor(seconds / 60) + " 分钟前";
}

function snapshot() {
  var error = ensureSession();
  if (!session) return { devices: [], status: error };

  var now = Date.now();
  if (now - session.lastQueryAt >= MIN_QUERY_GAP_MS) {
    session.lastQueryAt = now;
    var hit = readBattery();
    if (hit) {
      session.responder = hit.id;
      session.level = hit.reading.level;
      session.charging = hit.reading.charging;
      session.lastReplyAt = Date.now();
    } else {
      // 接收器在，但键盘不应答：已关机或进入二级休眠（闲置 10 分钟断连）
      session.lastReplyAt = null;
      session.level = null;
    }
  }

  if (session.lastReplyAt === null || session.level === null) {
    return {
      devices: [],
      status: error || "接收器在线，但键盘没有应答（已关机或休眠），敲任意键唤醒后自动恢复"
    };
  }

  var detail = "厂商通道 0x1A · 接收器直查";
  if (session.charging) detail += " · 充电中";

  var extra = {
    "接收器": "VID 0x320F PID 0x5088",
    "协议": "0x1A GetBatterLevel",
    "报文": ago(Date.now())
  };

  return {
    devices: [{
      id: "vgn-2.4g",
      name: "VGN 键盘（2.4G）",
      kind: "keyboard",
      transport: "usb",
      level: session.level,
      charging: session.charging,
      connected: true,
      detail: detail,
      lastUpdate: session.lastReplyAt,
      stale: Date.now() - session.lastReplyAt > 180000,
      extra: extra,
      sourcePolicy: "preferPlugin"
    }],
    status: error
  };
}

function selfTest() {
  var errors = [];

  // 实机原始回包（64 字节，含 Report ID）：94% 充电中
  var real = [0x04, 0x00, 0x00, 0x1A, 0x06, 0x00, 0x00, 0x00, 0x5E, 0x01, 0x00, 0x00,
              0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
  var parsed = parseReply(real);
  if (!parsed || parsed.level !== 94 || !parsed.charging) errors.push("实机回包（94% 充电中）");

  // 同一报文去掉 Report ID：解析结果必须一致
  var stripped = real.slice(1);
  var parsedStripped = parseReply(stripped);
  if (!parsedStripped || parsedStripped.level !== 94) errors.push("无 Report ID 回包");

  // 未充电样本（50%）
  var idle = real.slice(0);
  idle[8] = 0x32;
  idle[9] = 0x00;
  var parsedIdle = parseReply(idle);
  if (!parsedIdle || parsedIdle.level !== 50 || parsedIdle.charging) errors.push("未充电回包（50%）");

  // 命令码不匹配：忽略
  var wrongCmd = real.slice(0);
  wrongCmd[3] = 0x05;
  if (parseReply(wrongCmd) !== null) errors.push("非 0x1A 回包应忽略");

  // 电量越界：忽略
  var overflow = real.slice(0);
  overflow[8] = 0x65;
  if (parseReply(overflow) !== null) errors.push("电量 >100 应忽略");

  // 过短报文：忽略
  if (parseReply([0x04, 0x00, 0x00, 0x1A]) !== null) errors.push("过短报文应忽略");
  if (parseReply(null) !== null) errors.push("空报文应忽略");

  // 请求帧形态：Report ID 在首字节，命令码在整体第 4 字节
  var frame = buildRequest();
  if (frame.length !== 64) errors.push("请求帧长度");
  if (frame[0] !== 0x04 || frame[3] !== 0x1A || frame[4] !== 0x06) errors.push("请求帧内容");

  if (typeof hid === "undefined" || !Array.isArray(hid.listDevices({}))) errors.push("HID 桥 listDevices");
  if (!Array.isArray(hid.listDevices({ vendorID: VID, productID: PID }))) errors.push("HID 桥筛选");

  return errors;
}
