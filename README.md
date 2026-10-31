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

## 安装

1. 到 [Releases](../../releases) 下载对应插件的 zip（例如 `com.powermeter.xinmeng-1.0.0.pmplugin.zip`）。
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
├── index.json          # 构建产物：插件索引（版本、兼容性、下载地址、SHA-256）
├── build.sh            # 打包 zip、生成 sha256 与 index.json、跑插件自测
└── releases/           # 打包产物（不进 git）
```

## 构建与自测

```bash
./build.sh
```

脚本会依次完成：校验每个插件的清单 → 打包 `.pmplugin.zip` → 计算 SHA-256 →
生成 `index.json` → 调用 PowerMeter 的 `--plugin-self-test` 跑插件内的 `selfTest()`。

产物在 `releases/`：

```text
com.powermeter.logitech-hidpp-1.0.0.pmplugin.zip
com.powermeter.logitech-hidpp-1.0.0.pmplugin.zip.sha256
com.powermeter.xinmeng-1.0.0.pmplugin.zip
com.powermeter.xinmeng-1.0.0.pmplugin.zip.sha256
```

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

1. 修改插件内的 `manifest.json` 版本号和 `plugin.js`。
2. `./build.sh`，确认自测通过。
3. 提交并打标签：`git tag -a v1.1.0 -m "插件 1.1.0" && git push origin main v1.1.0`。
4. 在 GitHub Release 里上传 `releases/` 下的 zip 与 sha256，让 `index.json` 里的下载地址保持有效。

插件版本与 App 版本各自独立：插件升级不需要重装 App；
只有当插件声明的 `apiVersion` / `minimumAppVersion` 高于当前 App 时，才需要升级主程序。
