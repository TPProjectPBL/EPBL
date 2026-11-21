# shared/gaze/models

存放 MediaPipe 模型文件（二进制，**不进 git**）。

## 首次运行

```bash
bash scripts/fetch-gaze-model.sh
```

脚本会下载：

```text
shared/gaze/models/face_landmarker.task
```

要求文件大小 > 3MB（官方 float16 约 3.7MB）。

## 手动放置

如果脚本下载失败，把 `face_landmarker.task` 手动放到：

```text
shared/gaze/models/face_landmarker.task
```

官方地址：

```text
https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task
```

## 为什么不入库

`*.task` 已在 `.gitignore` 中忽略（体积大、且老师要求权重不入库）。
本目录只保留 `.gitkeep` 与这份说明。

## 回退

本地文件缺失时，`face-engine.js` 默认会回退到 CDN 同一地址（可用 `allowCdnFallback: false` 关闭）。
