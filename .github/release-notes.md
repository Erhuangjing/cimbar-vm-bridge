## 下载哪个？

| 文件 | 用途 |
| --- | --- |
| `cimbar-vm-bridge-*.zip` | 完整包：发送端、接收端、本地服务器脚本（`启动服务器.bat`）。解压到 Win11 宿主机即可 |
| `cimbar-send.html` | 只要发送端：放进 Win7 虚拟机，用 Chrome 109 / Firefox ESR 115 打开 |
| `cimbar-recv.html` | 只要接收端：在 Win11 上双击打开，点「捕获屏幕 / 窗口」选中虚拟机窗口 |

两个 HTML 都是单文件，解码核心已内嵌，双击即可离线使用。详细用法见 [README](https://github.com/Erhuangjing/cimbar-vm-bridge#readme)。

解码核心：libcimbar release v0.6.8 预编译 WASM（未修改）。
