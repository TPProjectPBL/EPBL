# 打包与分发（S5）

把 `control-backend/launcher_cocoa.py` 打成 `隔空控制器.app`，再封装成 DMG。

产物：`packaging/dist/隔空控制器-v1.0.0-<arch>.dmg`（附 `.sha256`）

## 前置条件

```bash
# 运行环境（已存在可跳过）
python3 -m venv control-backend/.venv
control-backend/.venv/bin/pip install -r control-backend/requirements.txt
control-backend/.venv/bin/pip install py2app
```

## 一条命令构建

```bash
packaging/build_dmg.sh
```

脚本流程：

1. `rsync` 把仓库复制到 `packaging/stage/site`（排除 `.git`、`.venv`、`.deepworks`、`outputs`、`packaging`）
2. `setup.py py2app` → `packaging/dist/隔空控制器.app`
3. `codesign --force --deep --sign -`（ad-hoc）并 `--verify`
4. `hdiutil create` 生成 DMG（含 `/Applications` 快捷方式与安装说明）
5. 输出 SHA-256

## 运行期结构

```
隔空控制器.app/Contents/
├── MacOS/隔空控制器                  # pyobjc 主程序
└── Resources/site/                   # 完整静态站点（工作台 + 12 个页面 + vendor）
```

首次 Start 时会在
`~/Library/Application Support/隔空控制器/venv`
创建运行环境并安装 `control-backend/requirements.txt`，再执行
`playwright install chromium`（失败只告警，不阻断静态站点与工作台）。

## 架构

DMG 名称带 `uname -m` 后缀。arm64 与 x86_64 需分别在对应机器上构建，产物不能通用。

## 已知限制

- 未做 Apple Developer 签名/公证：首次打开需「右键 → 打开」。
- Chromium 不打包进 DMG（体积与版本绑定），首次运行按需下载。
- 打包体积主要来自 `vendor/`（约 76MB），DMG 压缩后通常 30–50MB。

## 自动化自检

```bash
# 窗口出现后自动 Start，便于脚本验证
AC_AUTOSTART=1 "packaging/dist/隔空控制器.app/Contents/MacOS/隔空控制器" &
sleep 8
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8125/workbench/
```
