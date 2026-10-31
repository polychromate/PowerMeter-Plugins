var SW_ID = 0x01;
var session = null;

function statusName(status) {
  switch (status) {
    case 0: return "放电中";
    case 1: return "充电中";
    case 2: return "即将充满";
    case 3: return "已充满";
    case 4: return "慢速充电";
    case 5: return "电池类型异常";
    case 6: return "温度异常";
    case 7: return "充电故障";
    default: return "状态未知";
  }
}

function bucketPercent(bucket) {
  switch (bucket) {
    case 1: return 5;
    case 2: return 25;
    case 4: return 70;
    case 8: return 100;
    default: return 50;
  }
}

function voltagePercent(millivolts) {
  var low = millivolts < 3300 ? 1800 : 3450;
  var high = millivolts < 3300 ? 3000 : 4200;
  return Math.min(100, Math.max(0, Math.round((millivolts - low) * 100 / (high - low))));
}

function decodeUTF8(bytes) {
  var encoded = "";
  for (var i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) continue;
    encoded += "%" + ("0" + bytes[i].toString(16)).slice(-2);
  }
  try {
    return decodeURIComponent(encoded);
  } catch (error) {
    return "";
  }
}

function cacheFor(slot) {
  var key = String(slot);
  if (!session.featureCache[key]) session.featureCache[key] = {};
  return session.featureCache[key];
}

function call(devIndex, feature, fn, params, timeout) {
  if (!session) return null;
  var packet = [0x10, devIndex, feature, ((fn << 4) | SW_ID) & 0xFF];
  for (var i = 0; i < params.length; i++) packet.push(params[i]);
  while (packet.length < 7) packet.push(0);
  packet = packet.slice(0, 7);

  hid.takeReports(session.id);
  if (!hid.setReport({ id: session.id, type: "output", reportID: 0x10, data: packet })) return null;

  var deadline = Date.now() + (timeout || 0.35) * 1000;
  while (Date.now() < deadline) {
    hid.wait(8);
    var reports = hid.takeReports(session.id);
    for (var r = 0; r < reports.length; r++) {
      var report = reports[r];
      if (report.length < 5) continue;
      if (report[1] === devIndex && report[2] === 0x8F) return null;
      if (report[1] === devIndex && report[2] === feature && (report[3] & 0x0F) === SW_ID) {
        return report;
      }
    }
  }
  return null;
}

function featureIndex(featureId, devIndex) {
  var cache = cacheFor(devIndex);
  var key = String(featureId);
  if (cache[key] !== undefined) return cache[key];
  var report = call(devIndex, 0x00, 0x00, [featureId >> 8, featureId & 0xFF, 0]);
  if (!report || report.length <= 4 || report[4] === 0) return null;
  cache[key] = report[4];
  return report[4];
}

function slotRange() {
  if (session.isReceiver) return [1, 2, 3, 4, 5, 6];
  return [0xFF];
}

function isAlive(slot) {
  var report = call(slot, 0x00, 0x01, [0x00, 0x00, 0xAA], 0.22);
  return !!report && report.indexOf(0xAA) >= 0;
}

function deviceName(slot) {
  var key = String(slot);
  if (session.nameCache[key]) return session.nameCache[key];
  var index = featureIndex(0x0005, slot);
  if (!index) return null;
  var lengthReport = call(slot, index, 0x00, [0, 0, 0]);
  if (!lengthReport || lengthReport.length <= 4) return null;
  var total = lengthReport[4];
  if (total <= 0 || total > 64) return null;

  var bytes = [];
  var offset = 0;
  while (offset < total && bytes.length < total) {
    var chunk = call(slot, index, 0x01, [offset, 0, 0]);
    if (!chunk || chunk.length <= 4) break;
    var remaining = total - bytes.length;
    for (var i = 4; i < chunk.length && bytes.length < total && i - 4 < remaining; i++) {
      bytes.push(chunk[i]);
    }
    offset += 16;
  }
  var name = decodeUTF8(bytes).trim();
  if (!name) return null;
  session.nameCache[key] = name;
  return name;
}

function battery(slot) {
  var index = featureIndex(0x1000, slot);
  if (index) {
    var report = call(slot, index, 0x00, [0, 0, 0]);
    if (report && report.length > 6) {
      var level = report[4];
      var status = report[6];
      if (level <= 100 && status <= 7) {
        return {
          level: status === 3 ? 100 : level,
          charging: [1, 2, 4].indexOf(status) >= 0,
          detail: "HID++ 0x1000 · " + statusName(status)
        };
      }
    }
  }

  index = featureIndex(0x1004, slot);
  if (index) {
    var caps = call(slot, index, 0x00, [0, 0, 0]);
    var hasPercent = !!caps && caps.length > 5 && (caps[5] & 0x02) !== 0;
    var info = call(slot, index, 0x01, [0, 0, 0]);
    if (info && info.length > 6) {
      var unifiedStatus = info[6];
      if (unifiedStatus <= 7) {
        var unifiedLevel = hasPercent ? info[4] : bucketPercent(info[5]);
        if (unifiedStatus === 3) unifiedLevel = 100;
        return {
          level: Math.min(100, Math.max(0, unifiedLevel)),
          charging: [1, 2, 4].indexOf(unifiedStatus) >= 0,
          detail: "HID++ 0x1004 · " + statusName(unifiedStatus)
        };
      }
    }
  }

  index = featureIndex(0x1001, slot);
  if (index) {
    var voltage = call(slot, index, 0x00, [0, 0, 0]);
    if (voltage && voltage.length > 6) {
      var millivolts = voltage[4] | (voltage[5] << 8);
      if (millivolts > 0) {
        var flags = voltage[6];
        return {
          level: voltagePercent(millivolts),
          charging: (flags & 0x80) !== 0,
          detail: millivolts + " mV（电压换算）",
          voltageMillivolts: millivolts
        };
      }
    }
  }
  return null;
}

function ensureSession() {
  var devices = hid.listDevices({ vendorID: 0x046D, usagePage: 0xFF00, usage: 0x01 });
  if (devices.length === 0) {
    if (session) {
      hid.closeDevice(session.id);
      session = null;
    }
    return "";
  }

  var selected = devices[0];
  for (var i = 0; i < devices.length; i++) {
    if ((devices[i].product || "").toLowerCase().indexOf("receiver") >= 0) {
      selected = devices[i];
      break;
    }
  }

  if (session && session.id === selected.id) return "";
  if (session) hid.closeDevice(session.id);
  if (!hid.openDevice(selected.id)) return hid.status() || "无法打开罗技 HID++ 设备";
  session = {
    id: selected.id,
    isReceiver: (selected.product || "").toLowerCase().indexOf("receiver") >= 0,
    featureCache: {},
    nameCache: {}
  };
  return "";
}

function snapshot() {
  var error = ensureSession();
  if (!session) return { devices: [], status: error };

  var devices = [];
  var slots = slotRange();
  for (var i = 0; i < slots.length; i++) {
    var slot = slots[i];
    if (!isAlive(slot)) {
      delete session.nameCache[String(slot)];
      continue;
    }
    var name = deviceName(slot);
    if (!name) continue;
    var reading = battery(slot);
    var transport = session.isReceiver ? "logitechReceiver" : "bluetooth";
    var extra = { "协议": reading ? reading.detail : "HID++" };
    if (reading && reading.voltageMillivolts) extra["电压"] = reading.voltageMillivolts + " mV";
    var route = session.isReceiver ? "接收器直读" : "蓝牙直读";
    devices.push({
      id: "logitech-" + (session.isReceiver ? "receiver" : "direct") + "-" + slot + "-" + name,
      name: name,
      transport: transport,
      level: reading ? reading.level : null,
      charging: reading ? reading.charging : false,
      connected: true,
      detail: reading ? (reading.charging ? route + " · 充电中" : route) : "已连接，本次未读到电量（设备休眠）",
      lastUpdate: Date.now(),
      stale: false,
      extra: extra,
      sourcePolicy: "preferPlugin"
    });
  }
  return { devices: devices, status: error };
}

function selfTest() {
  var errors = [];
  if (statusName(1) !== "充电中") errors.push("statusName(1)");
  if (bucketPercent(1) !== 5) errors.push("bucketPercent(1)");
  if (voltagePercent(4200) !== 100) errors.push("voltagePercent(4200)");
  if (voltagePercent(3450) !== 0) errors.push("voltagePercent(3450)");
  if (decodeUTF8([77, 88, 32, 75, 101, 121, 115, 0]) !== "MX Keys") errors.push("decodeUTF8");
  if (typeof hid === "undefined" || !Array.isArray(hid.listDevices({}))) errors.push("HID 桥 listDevices");
  if (!Array.isArray(hid.listDevices({ vendorID: 0x046D, usagePage: 0xFF00, usage: 0x01 }))) {
    errors.push("HID 桥筛选");
  }
  return errors;
}
