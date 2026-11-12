# 协作规范

本仓库是 PBL 课程项目「隔空控制器（Air Controller）」。**成绩按 GitHub 贡献记录评定**，
所以请保证你的工作通过 Issue / PR / Commit 留下可追踪的记录，并在其中 `@你的GitHub用户名`。

---

## 一、工作流程

所有改动走同一套流程，不要直接往 `main` 推：

```
1. 先开 Issue     描述要做什么 / 复现了什么 bug
2. 建分支         从最新的 main 拉出
3. 提交            小而完整，一个提交做一件事
4. 开 PR           关联 Issue，写清改了什么、怎么验证
5. 合并            至少一人 review 后合并到 main
```

### 分支命名

| 类型 | 格式 | 示例 |
|---|---|---|
| 新功能 | `feat/<模块>-<简述>` | `feat/dual-test-calib` |
| 修复 | `fix/<模块>-<简述>` | `fix/air-runner-calib-drift` |
| 文档 | `docs/<简述>` | `docs/wasm-report` |

### Issue / PR 要求

- Issue 标题写清楚**现象**或**目标**，不要只写「有问题」
- PR 描述必须包含：关联的 Issue（`Closes #12`）、改动点、自测方式
- 认领任务时在 Issue 里 `@自己`，合并后由 PR 自动关闭

## 二、Commit 规范

格式：`<类型>(<模块>): <中文描述>`

```
feat(draw): 捏合落笔 + One Euro 平滑
fix(air-runner): 修复标定漂移导致光标右偏
docs: 补充 draw 的 README
test(control-backend): 真实 Chrome 控制验证
chore: 补充 .gitignore
```

要求：

- 类型只用 `feat` / `fix` / `docs` / `test` / `chore` / `refactor`
- 描述用中文，一句话说清**做了什么**，不写「update」「修改」这种没信息量的词
- 一个提交只做一件事；顺手的格式化请单独提交
- **不要 amend 已推送的提交**，也不要用 force push

## 三、禁止提交的内容

| 内容 | 原因 |
|---|---|
| `node_modules/`、`venv/`、`vendor/` 下的第三方库 | 体积大，可重新安装 |
| `*.task`、`*.tflite`、`*.onnx` 等模型权重 | 单个 5–8MB，应给下载地址 |
| 摄像头录制、人脸照片、标定截图 | 隐私，仓库是公开的 |
| 采集的原始数据（CSV / JSON） | 含生物特征，需脱敏后再决定 |
| `dist/`、`build/`、日志文件 | 构建产物 |
| 密钥、token、内网 IP、账号密码 | 安全事故 |

已有的历史遗留（`draw/vendor/`、`controller-demo/vendor/`）见 Issue #待定，暂不处理。

## 四、本地运行

所有 demo 都是纯静态页面，但用了 ES Module 与 `getUserMedia`，**不能用 `file://` 直接打开**，
必须起一个本地 HTTP 服务：

```bash
# 在仓库根目录
python3 -m http.server 8000
# 浏览器打开 http://localhost:8000/draw/index-3-hand.html
```

摄像头权限只在 `localhost` 或 `https` 下可用。断网环境下，只有使用本地 `vendor/` 的
demo 能跑（`gesture-test`、`controller-demo`、`draw`）；`eye-page-turner/demo` 依赖 CDN，
断网会加载失败。

## 五、保密与公开性

本仓库是**公开仓库**。上传前请自查：

```bash
git status                 # 有没有多出来的临时文件
git diff --cached          # 逐行看一遍要提交的内容
```

不确定的内容先在群里问，不要直接推。
