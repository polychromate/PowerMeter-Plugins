// 无硬件回归：用假 hid 桥跑 plugin.js 的分支逻辑
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const target = process.argv[2] || path.join(__dirname, "..", "VGN24G.pmplugin", "plugin.js");
const source = fs.readFileSync(target, "utf8");

function run(name, mock, check) {
  const sandbox = { hid: mock, Date, Math, console };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  const result = sandbox.snapshot();
  const errors = check(result);
  console.log(`${errors.length === 0 ? "PASS" : "FAIL"}  ${name}`);
  errors.forEach((e) => console.log("      " + e));
  return errors.length === 0;
}

function replyFrame(level, charging) {
  const f = new Array(64).fill(0);
  f[0] = 0x04; f[3] = 0x1a; f[4] = 0x06;
  f[8] = level; f[9] = charging ? 1 : 0;
  return f;
}

function makeHid(state) {
  return {
    listDevices: () => state.devices,
    openDevice: (id) => { state.opened.push(id); return true; },
    closeDevice: () => {},
    setReport: (req) => {
      state.sends.push({ id: req.id, len: req.data.length, head: req.data.slice(0, 5) });
      state.pending[req.id] = state.reply ? [state.reply] : [];
      return true;
    },
    takeReports: (id) => { const r = state.pending[id] || []; state.pending[id] = []; return r; },
    wait: () => {},
    status: () => ""
  };
}

let allOk = true;

// 1. 接收器不在
allOk &= run("接收器缺失 → 空列表", makeHid({ devices: [], opened: [], sends: [], pending: {}, reply: null }), (r) => {
  const e = [];
  if (r.devices.length !== 0) e.push("应返回空列表");
  if (!/未检测到/.test(r.status || "")) e.push("status 应提示未检测到接收器: " + r.status);
  return e;
});

// 2. 接收器在、键盘不应答（休眠）
allOk &= run("键盘不应答 → 隐藏该行", makeHid({ devices: [{ id: "a" }, { id: "b" }], opened: [], sends: [], pending: {}, reply: null }), (r) => {
  const e = [];
  if (r.devices.length !== 0) e.push("应答失败时应隐藏, 实际 " + JSON.stringify(r.devices));
  if (!/没有应答/.test(r.status || "")) e.push("status 应说明键盘没有应答: " + r.status);
  return e;
});

// 3. 正常回包（带 Report ID）
const okState = { devices: [{ id: "a" }, { id: "b" }], opened: [], sends: [], pending: {}, reply: replyFrame(88, false) };
allOk &= run("正常回包 → 88% 未充电", makeHid(okState), (r) => {
  const e = [];
  if (r.devices.length !== 1) e.push("应返回 1 台设备");
  const d = r.devices[0] || {};
  if (d.level !== 88) e.push("电量应为 88, 实际 " + d.level);
  if (d.charging !== false) e.push("不应标记充电");
  if (!d.connected) e.push("connected 应为 true");
  if (d.charging) e.push("charging 应为 false");
  return e;
});

// 4. 请求帧形态：两接口都发一次，64 字节，Report ID 在首字节
(() => {
  const st = { devices: [{ id: "a" }, { id: "b" }], opened: [], sends: [], pending: {}, reply: replyFrame(60, true) };
  allOk &= run("回包 → 60% 充电中", makeHid(st), (r) => {
    const e = [];
    if (r.devices[0] && r.devices[0].charging !== true) e.push("应标记充电");
    if (st.sends.length !== 2) e.push("首次应扇出到两个接口, 实际 " + st.sends.length);
    st.sends.forEach((s) => {
      if (s.len !== 64) e.push("帧长应为 64, 实际 " + s.len);
      if (s.head[0] !== 0x04) e.push("首字节应为 Report ID 0x04");
      if (s.head[3] !== 0x1a || s.head[4] !== 0x06) e.push("命令码位置不对: " + JSON.stringify(s.head));
    });
    return e;
  });
})();

console.log(allOk ? "\n全部通过" : "\n有用例失败");
process.exit(allOk ? 0 : 1);
