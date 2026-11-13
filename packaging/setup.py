"""py2app 打包配置：把控制小窗打成「隔空控制器.app」。

用法（在 packaging/ 目录）：
    ../control-backend/.venv/bin/python setup.py py2app

静态站点会先由 build_dmg.sh 复制到 stage/site，
再由 py2app 放进 .app/Contents/Resources/site。
"""
import sys
from pathlib import Path

from setuptools import setup

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "control-backend"))

APP = [str(HERE.parent / "control-backend" / "launcher_cocoa.py")]

OPTIONS = {
    "argv_emulation": False,
    "packages": ["objc", "AppKit", "Foundation", "Quartz"],
    "includes": ["launcher"],
    "resources": [str(HERE / "stage" / "site")],
    "plist": {
        "CFBundleName": "隔空控制器",
        "CFBundleDisplayName": "隔空控制器",
        "CFBundleIdentifier": "com.epbl.aircontroller",
        "CFBundleShortVersionString": "1.0.0",
        "CFBundleVersion": "1.0.0",
        "LSUIElement": False,
        "NSHighResolutionCapable": True,
        "NSCameraUsageDescription": "用于眼动与手势识别，画面仅在本机处理，不上传。",
    },
}

setup(
    app=APP,
    name="隔空控制器",
    options={"py2app": OPTIONS},
    setup_requires=["py2app"],
)
