#!/bin/bash
# 逐插件打包：每个插件独立成包、独立版本、独立发布地址。
# 源码没变的插件跳过重打，压缩包哈希保持不变。
#
#   ./build.sh                  # 构建全部（未改动的跳过）
#   ./build.sh vgn              # 只构建目录名/id 含 vgn 的插件
#   ./build.sh --force vgn      # 强制重打指定插件
#   ./build.sh --list           # 列出插件与版本
set -euo pipefail
cd "$(dirname "$0")"

FORCE=0
FILTER=""

for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --list)
      for dir in *.pmplugin; do
        [ -d "$dir" ] || continue
        python3 - "$dir/manifest.json" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
print(f'{m["id"]:<32} {m["name"]:<12} v{m["version"]}')
PY
      done
      exit 0 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    -*) echo "未知参数：$arg" >&2; exit 2 ;;
    *) FILTER="$arg" ;;
  esac
done

mkdir -p releases .build
BASE_URL="${POWERMETER_PLUGIN_BASE_URL:-https://github.com/polychromate/PowerMeter-Plugins/releases/download}"

manifest_field() {
  python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$1" "$2"
}

# 源码指纹：manifest + plugin.js 的内容哈希，与文件时间戳无关
fingerprint_of() {
  cat "$1/manifest.json" "$1/plugin.js" | shasum -a 256 | awk '{print $1}'
}

BUILT=""
SKIPPED=""

for dir in *.pmplugin; do
  [ -d "$dir" ] || continue
  ID=$(manifest_field "$dir/manifest.json" id)
  VERSION=$(manifest_field "$dir/manifest.json" version)

  if [ -n "$FILTER" ]; then
    case "$dir $ID" in
      *"$FILTER"*) ;;
      *) continue ;;
    esac
  fi

  if command -v node >/dev/null 2>&1; then
    node --check "$dir/plugin.js"
  fi

  ARCHIVE="releases/${ID}-${VERSION}.pmplugin.zip"
  STAMP=".build/${ID}.fingerprint"
  CURRENT=$(fingerprint_of "$dir")

  if [ "$FORCE" -eq 0 ] && [ -f "$ARCHIVE" ] && [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$CURRENT" ]; then
    SKIPPED="$SKIPPED ${ID}"
    echo "==> 跳过 ${ID}（源码未变）"
    continue
  fi

  echo "==> 打包 $ARCHIVE"
  STAGE=$(mktemp -d)
  cp -R "$dir" "$STAGE/"
  find "$STAGE" -name '.DS_Store' -delete
  # 时间戳必须固定，否则同样源码在不同时刻打出的包字节不同、哈希不可复现。
  # 取该插件目录最后一次 git 提交时间：既确定（同一份源码 → 同一个值），
  # 又有真实含义（解压看到的是这个插件最后的修改日期），不会出现莫名其妙的年份。
  # 尚未提交过的目录（或是从 tarball 解出来的）退回一个显式占位值。
  MTIME=$(git log -1 --format=%cd --date=format:%Y%m%d%H%M.%S -- "$dir" 2>/dev/null || true)
  if [ -z "$MTIME" ]; then
    MTIME=202001010000.00
    echo "    提示：$dir 没有 git 提交记录，时间戳使用占位值 $MTIME"
  fi
  # 用 zip 而不是 ditto，避免把 __MACOSX/._* 资源叉塞进包里
  find "$STAGE" -exec touch -t "$MTIME" {} +
  ( cd "$STAGE" && find "$dir" | LC_ALL=C sort | zip -q -X "$OLDPWD/$ARCHIVE" -@ )
  rm -rf "$STAGE"

  shasum -a 256 "$ARCHIVE" | awk '{print $1}' > "$ARCHIVE.sha256"
  echo "$CURRENT" > "$STAMP"
  BUILT="$BUILT ${ID}"
done

# 合并索引：只更新本次涉及的插件条目，其它条目原样保留
python3 - "$BASE_URL" $BUILT <<'PY'
import hashlib
import json
import sys
from pathlib import Path

base_url = sys.argv[1].rstrip("/")
rebuilt = set(sys.argv[2:])

root = Path(".")
index_path = root / "index.json"
existing = {}
if index_path.exists():
    try:
        for entry in json.loads(index_path.read_text()).get("plugins", []):
            existing[entry["id"]] = entry
    except json.JSONDecodeError:
        pass

plugins = []
missing = []
for manifest_path in sorted(root.glob("*.pmplugin/manifest.json")):
    manifest = json.loads(manifest_path.read_text())
    plugin_id = manifest["id"]
    slug = plugin_id.split(".")[-1]
    archive = root / "releases" / f'{plugin_id}-{manifest["version"]}.pmplugin.zip'
    if not archive.exists():
        missing.append(plugin_id)
        continue
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    entry = {
        "id": plugin_id,
        "name": manifest["name"],
        "version": manifest["version"],
        "apiVersion": manifest["apiVersion"],
        "minimumAppVersion": manifest["minimumAppVersion"],
        "description": manifest.get("description", ""),
        # 一个插件一个 Release，标签形如 vgn-24g-v1.0.0
        "url": f'{base_url}/{slug}-v{manifest["version"]}/{archive.name}',
        "sha256": digest,
    }
    old = existing.get(plugin_id)
    if old and plugin_id not in rebuilt and old.get("url") == entry["url"] and old.get("sha256") == digest:
        entry = old
    plugins.append(entry)

index_path.write_text(json.dumps({"schemaVersion": 1, "plugins": plugins},
                                 ensure_ascii=False, indent=2) + "\n")
print(f"==> index.json 已更新（共 {len(plugins)} 个插件，本次重建 {len(rebuilt)} 个）")
if missing:
    print("    尚未打包：" + "、".join(missing))
PY

APP="${POWERMETER_APP:-../PowerMeter-git/build/PowerMeter.app/Contents/MacOS/PowerMeter}"
if command -v node >/dev/null 2>&1 && [ -d tests ]; then
  echo "==> 运行无硬件回归脚本"
  for test in tests/*.js; do
    [ -f "$test" ] || continue
    node "$test"
  done
fi

if [ -x "$APP" ]; then
  echo "==> 使用主程序运行插件自测"
  POWERMETER_PLUGIN_DIR="$PWD" "$APP" --plugin-self-test
fi

echo "==> 完成"
for id in $BUILT; do echo "    打包 ${id}"; done
for id in $SKIPPED; do echo "    跳过 ${id}（源码未变）"; done
if [ -z "$BUILT" ] && [ -z "$SKIPPED" ]; then echo "    （没有匹配的插件）"; fi
for f in releases/*.pmplugin.zip; do [ -f "$f" ] && printf "    %-58s %s\n" "$f" "$(du -h "$f" | cut -f1)"; done
