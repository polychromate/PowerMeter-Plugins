#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p releases
rm -f releases/*.pmplugin.zip releases/*.sha256 index.json

for plugin in *.pmplugin; do
  [ -d "$plugin" ] || continue
  echo "==> 检查 $plugin"
  if command -v node >/dev/null 2>&1; then
    node --check "$plugin/plugin.js"
  fi

  ID=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"])' "$plugin/manifest.json")
  VERSION=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$plugin/manifest.json")
  ARCHIVE="releases/${ID}-${VERSION}.pmplugin.zip"

  echo "==> 打包 $ARCHIVE"
  ditto -c -k --sequesterRsrc --keepParent "$plugin" "$ARCHIVE"
  shasum -a 256 "$ARCHIVE" | awk '{print $1}' > "$ARCHIVE.sha256"
done

python3 - <<'PY'
import hashlib
import json
from pathlib import Path

root = Path(".")
plugins = []
for manifest_path in sorted(root.glob("*.pmplugin/manifest.json")):
    manifest = json.loads(manifest_path.read_text())
    archive = root / "releases" / f'{manifest["id"]}-{manifest["version"]}.pmplugin.zip'
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    plugins.append({
        "id": manifest["id"],
        "name": manifest["name"],
        "version": manifest["version"],
        "apiVersion": manifest["apiVersion"],
        "minimumAppVersion": manifest["minimumAppVersion"],
        "description": manifest.get("description", ""),
        "url": str(archive),
        "sha256": digest,
    })

payload = {"schemaVersion": 1, "plugins": plugins}
Path("index.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
print(f"==> 已生成 index.json（{len(plugins)} 个插件）")
PY

APP="${POWERMETER_APP:-../PowerMeter-git/build/PowerMeter.app/Contents/MacOS/PowerMeter}"
if [ -x "$APP" ]; then
  echo "==> 使用主程序运行插件自测"
  POWERMETER_PLUGIN_DIR="$PWD" "$APP" --plugin-self-test
fi

echo "==> 插件构建完成"
ls -lh releases
