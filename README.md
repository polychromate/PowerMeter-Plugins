# PowerMeter 插件仓库

[PowerMeter](https://github.com/polychromate/PowerMeter) 的独立设备插件集合。
每个插件提供一款或一系列设备的电量读取能力，**安装插件不需要更新主程序**。

- 需要 PowerMeter **0.4.0+**，插件 API **v1**
- 插件在独立线程的 JavaScriptCore 上下文里运行，只能通过受控 HID 桥访问设备
- 插件包是纯数据 + 脚本，不含原生二进制

## 插件列表

| 插件 | id | 支持的设备 | 读取方式 |
| --- | --- | --- | --- |
| [罗技 HID++](LogitechHIDPP.pmplugin) | `com.powermeter.logitech-hidpp` | Unifying / Bolt 接收器下的罗技键鼠、蓝牙直连罗技外设 | HID++ 2.0：`0x1000` → `0x1004` → `0x1001`，自动探测 1–6 号槽位 |
| [新盟 2.4G](XinmengHID.pmplugin) | `com.powermeter.xinmeng` | 新盟 A99 / M71 等 2.4G 接收器键盘（VID `0x3554`） | vendor Input Report `0x13`，过滤设备离线占位报文 |
| [VGN 2.4G](VGN24G.pmplugin) | `com.powermeter.vgn-24g` | VGN S99 等 2.4G 接收器键盘（VID `0x320F` PID `0x5088`） | 厂商通道 Report 4 主动查询 `0x1A`，读电量与充电状态 |

## 安装

每个插件都是**独立的 zip**，按自己的设备下一个就够，不用装整套。

1. 到 [Releases](../../releases) 下载对应那一个插件的 zip（例如 `com.powermeter.xinmeng-1.0.0.pmplugin.zip`）。
2. 打开 PowerMeter 菜单面板 → **插件 › 安装插件…** → 选择该 zip。
3. 安装后自动生效；同 id 覆盖安装即为升级。

命令行安装：

```bash
/Applications/PowerMeter.app/Contents/MacOS/PowerMeter --install-plugin <zip 路径>
```

插件目录：`~/Library/Application Support/PowerMeter/Plugins/`。
卸载 = 删掉对应 `<id>.pmplugin` 目录后点「重新载入」。

## 目录结构

```text
PowerMeter-Plugins/
├── LogitechHIDPP.pmplugin/
│   ├── manifest.json
│   └── plugin.js
├── XinmengHID.pmplugin/
│   ├── manifest.json
│   └── plugin.js
├── VGN24G.pmplugin/
│   ├── manifest.json
│   └── plugin.js
├── tests/              # 无硬件的分支回归脚本（node 跑）
├── index.json          # 构建产物：插件目录（版本、兼容性、下载地址、SHA-256）
├── build.sh            # 逐插件打包 zip、算 sha256、合并 index.json、跑自测
├── release.sh          # 单插件发版：一个插件一个标签、一个 Release
├── .build/             # 源码指纹缓存，用于跳过未改动的插件（不进 git）
└── releases/           # 打包产物（不进 git）
```

## 构建与自测

```bash
./build.sh                 # 构建全部，源码没变的插件自动跳过
./build.sh vgn             # 只构建 VGN 这个插件
./build.sh --force vgn     # 强制重打（版本号没改但想刷新产物时用）
./build.sh --list          # 列出插件与版本
```

每个插件单独打成一个 `<id>-<version>.pmplugin.zip`：只含它自己的
`manifest.json` + `plugin.js`，没有 `__MACOSX` 之类资源叉；包内时间戳统一取
**该插件目录最后一次 git 提交时间**、文件按名排序，所以**同样的源码产出同样的字节**，
SHA-256 可复现、可校验，解压后看到的日期也就是这个插件最后改动的日期。

脚本还会跑两轮检查：`tests/*.js` 里的无硬件分支回归，以及调用 PowerMeter 的
`--plugin-self-test` 执行插件内的 `selfTest()`。

只跑自测、不打包：

```bash
POWERMETER_PLUGIN_DIR="$PWD" \
  /Applications/PowerMeter.app/Contents/MacOS/PowerMeter --plugin-self-test
```

## 想自己写插件

插件 = 一个目录 + `manifest.json` + `plugin.js`。
平台提供的 API、`snapshot()` 返回结构、来源策略、调试方法都写在主仓库的
[插件平台文档](https://github.com/polychromate/PowerMeter#四插件平台)。

最小清单示例：

```json
{
  "id": "com.example.device",
  "name": "示例设备",
  "version": "1.0.0",
  "apiVersion": 1,
  "minimumAppVersion": "0.4.0",
  "entry": "plugin.js",
  "sourcePolicy": "fallback"
}
```

## 发布新版本

版本、标签、Release 都**按插件独立**，互不影响：写一个新插件不需要重发别人的包。

```bash
# 1. 改这个插件的 manifest.json 版本号和 plugin.js
# 2. 只打这一个插件，确认自测通过
./build.sh vgn

# 3. 发布：一个插件一个标签、一个 Release
./release.sh vgn --dry-run   # 先看一眼要执行的命令
./release.sh vgn
```

标签形如 `vgn-24g-v1.0.0`、`xinmeng-v1.1.0`，Release 里只挂这一个插件的 zip 与
`.sha256`；`index.json` 里每个条目的 `url` 各自指向自己的标签。
同版本重复发布会直接报错退出，提醒你先改版本号。

`index.json` 只是**目录**，不是捆绑包：它列出每个插件的最新版本、兼容性、下载地址和
哈希，用户按自己的设备只下其中一个 zip。

### Releases 页面怎么读

一个插件一个 Release，标签就是 `<slug>-v<version>`（`logitech-hidpp-v1.0.0`、
`xinmeng-v1.0.0`、`vgn-24g-v1.0.0`），每个 Release 里只有它自己的 zip 和 `.sha256`。
仓库里**没有**「整包下载」这种东西——按设备挑一个装就行。

GitHub 的 `Latest` 徽标只能指向其中一个 Release，落在最近发过版的那个插件上，
**不代表「仓库整体最新版本」**；要看某个插件是不是最新，看它自己的标签或 `index.json`。

> 历史：早先的 `v1.0.0` 是「所有插件捆在一个 Release + 一个仓库级版本号」的旧做法，
> 已于 2026-11 删除并拆成上面三个独立 Release，旧标签 `v1.0.0` 一并移除。

插件版本与 App 版本各自独立：插件升级不需要重装 App；
只有当插件声明的 `apiVersion` / `minimumAppVersion` 高于当前 App 时，才需要升级主程序。
