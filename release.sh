#!/bin/bash
# 单插件发布：只打这一个插件、只开一个 Release，标签形如 vgn-24g-v1.0.0。
# 其它插件不会被重打包，也不会被重新上传。
#
#   ./release.sh vgn              # 发布匹配到的那个插件
#   ./release.sh vgn --dry-run    # 只打印将要执行的命令
#
# 发布前请先把 manifest.json 的 version 改掉（同版本重复发布会直接报错退出）。
set -euo pipefail
cd "$(dirname "$0")"

DRY=0
FILTER=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    -*) echo "未知参数：$arg" >&2; exit 2 ;;
    *) FILTER="$arg" ;;
  esac
done

if [ -z "$FILTER" ]; then
  echo "请指定要发布的插件，例如：./release.sh vgn" >&2
  echo "可用插件：" >&2
  ./build.sh --list >&2
  exit 2
fi

MATCHES=""
for candidate in *.pmplugin; do
  [ -d "$candidate" ] || continue
  candidate_id=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"])' "$candidate/manifest.json")
  if [[ "$candidate $candidate_id" == *"$FILTER"* ]]; then
    MATCHES="$MATCHES $candidate"
  fi
done
MATCHES="${MATCHES# }"

COUNT=0
for _ in $MATCHES; do COUNT=$((COUNT + 1)); done
if [ "$COUNT" -eq 0 ]; then
  echo "没有匹配 \"$FILTER\" 的插件" >&2
  exit 2
fi
if [ "$COUNT" -gt 1 ]; then
  echo "匹配到多个插件，请写得更具体：" >&2
  printf '  %s\n' $MATCHES >&2
  exit 2
fi

DIR="$MATCHES"
ID=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"])' "$DIR/manifest.json")
NAME=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["name"])' "$DIR/manifest.json")
VERSION=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$DIR/manifest.json")
SLUG="${ID##*.}"
TAG="${SLUG}-v${VERSION}"
ARCHIVE="releases/${ID}-${VERSION}.pmplugin.zip"

echo "==> 插件：${NAME}（${ID}）v${VERSION}"
echo "==> 标签：${TAG}"

if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  echo "标签 ${TAG} 已存在——请先改 manifest.json 的 version，再发布" >&2
  exit 1
fi
if git ls-remote --exit-code --tags origin "${TAG}" >/dev/null 2>&1; then
  echo "远端已有标签 ${TAG}——请先改 manifest.json 的 version" >&2
  exit 1
fi
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "提示：工作区有未提交改动，发布后记得提交（标签会指向最近的提交）"
fi

echo "==> 构建该插件"
./build.sh "$FILTER"

if [ ! -f "$ARCHIVE" ]; then
  echo "没找到构建产物 $ARCHIVE" >&2
  exit 1
fi

NOTES=$(cat <<EOF
${NAME} v${VERSION}

安装：下载 \`$(basename "$ARCHIVE")\`，在 PowerMeter 菜单面板选择「插件 › 安装插件…」，
或执行：

\`\`\`bash
/Applications/PowerMeter.app/Contents/MacOS/PowerMeter --install-plugin <zip 路径>
\`\`\`

SHA-256 见同名 \`.sha256\` 文件，也记录在 index.json 里。
EOF
)

run() {
  if [ "$DRY" -eq 1 ]; then
    echo "[dry-run] $*"
  else
    "$@"
  fi
}

run git tag -a "$TAG" -m "${NAME} ${VERSION}"
run git push origin main
run git push origin "$TAG"
# 每个插件各自发版，没有"仓库整体最新版本"这回事，所以不设置 Latest 标记
run ~/bin/gh release create "$TAG" "$ARCHIVE" "$ARCHIVE.sha256" \
  --title "${NAME} ${VERSION}" --notes "$NOTES" --latest=false

echo "==> 完成：${TAG}"
if [ "$DRY" -eq 1 ]; then
  echo "    （dry-run，未真正执行）"
fi
