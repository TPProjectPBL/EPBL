#!/bin/sh
# 在访达里双击本文件即可运行（等于自动打开终端并启动 demo）。
cd "$(dirname "$0")" || exit 1

/usr/bin/python3 main.py "$@"
code=$?

# 结束后停一下，方便看报错信息
echo
echo "程序已退出（退出码 $code）。按回车关闭窗口。"
read _ignored
exit $code
