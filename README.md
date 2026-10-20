# cimbar-vm-bridge

**Win7 虚拟机网页发送 → Win11 宿主机网页接收** 的离线传文件工具。

基于 [libcimbar](https://github.com/sz3/libcimbar)（彩色图标矩阵码 + 喷泉码 + Zstd 压缩）。发送端在虚拟机里把文件编码成连续播放的彩色条码，接收端在宿主机浏览器里用 **屏幕捕获（getDisplayMedia）** 直接抓取虚拟机窗口并实时解码。全程不经过网络，不需要 OBS 虚拟摄像头，也不需要虚拟机和宿主机之间有共享文件夹或剪贴板。

和原版相比的改动：

- 接收端新增 **「🖥️ 捕获屏幕 / 窗口」** 和 **「📷 使用摄像头」** 两个入口（交互参考 [AirScan-QR](https://github.com/topcss/AirScan-QR)）。
- 屏幕捕获使用 `MediaStreamTrackProcessor` 直接从视频轨道取帧（浏览器支持时）。接收端窗口被虚拟机窗口挡住、或者在后台时，仍然可以继续解码。
- 界面全部汉化，并为安全上下文、权限被拒、浏览器版本过旧、WebGL 不可用等常见问题提供中文提示。
- 每个页面打包为 **单个 HTML 文件**，WASM 以 base64 内嵌，可以直接双击用 `file://` 打开，不需要服务器。
- WASM / Zstd 解码核心保持不变，直接使用 libcimbar 官方 release v0.6.8 的预编译产物（见 `vendor/SHA256SUMS`）。

## 快速开始

需要的文件都在 [`dist/`](dist/) 目录：

| 文件 | 在哪儿用 | 说明 |
| --- | --- | --- |
| `cimbar-send.html` | Win7 虚拟机 | 发送端 |
| `cimbar-recv.html` | Win11 宿主机 | 接收端 |
| `启动服务器.bat` + `serve.ps1` | Win11 宿主机（可选） | 零依赖本地 HTTP 服务器，方便虚拟机直接从宿主机打开发送端 |

### 方式 A：直接双击（最简单）

1. 把 `cimbar-send.html` 放进 Win7 虚拟机（拖拽、共享文件夹、U 盘镜像都可以；只需要放一次），用 Chrome 109 或 Firefox ESR 115 打开。
2. 在 Win11 上双击 `cimbar-recv.html`，用 Chrome 或 Edge 打开。`file://` 属于安全上下文，屏幕捕获可以正常使用。
3. 继续看下面的「传输步骤」。

### 方式 B：宿主机开服务器，虚拟机用浏览器访问

1. 在 Win11 上双击 `dist/启动服务器.bat`。窗口里会列出本机所有 IP；如果弹出 Windows 防火墙提示，允许“专用网络”。
2. 在 Win7 虚拟机浏览器里打开 `http://<宿主机IP>:8000/cimbar-send.html`：
   - VMware NAT / 仅主机模式：一般使用 `VMnet8` / `VMnet1` 网卡的 IP。
   - VirtualBox NAT 模式：使用 `http://10.0.2.2:8000/`。
   - 打开后可以按 `Ctrl+S` 把页面保存到虚拟机本地，以后离线也能用。
3. 在 Win11 上打开 `http://localhost:8000/cimbar-recv.html`。注意要用 **localhost**，不要用局域网 IP，原因见下文。

> 也可以用 Python：在 `dist/` 目录执行 `python -m http.server 8000`。

### 传输步骤

1. 在发送端（虚拟机）点击页面或者把文件拖进去，按 **F11** 全屏。
2. 把虚拟机窗口尽量放大，虚拟机里的显示缩放保持 100%。条码越大，识别越稳定。
3. 在接收端（宿主机）点击 **「捕获屏幕 / 窗口」**，在弹窗的“窗口”标签页中选中虚拟机窗口，然后点“分享”。
4. 右上角的状态点变绿并显示百分比，说明正在接收。接收完成后文件会自动下载，左下角也会列出已收到的文件，可以再次点击下载。

## 兼容性

| 端 | 浏览器 | 说明 |
| --- | --- | --- |
| 发送端（Win7） | Chrome ≥ 85（推荐 **109**，Win7 上的最后一个版本）、Firefox ≥ 79（推荐 **ESR 115**）、Supermium | 需要 WebAssembly、BigInt 和 WebGL。在 `http://局域网IP` 下也能运行，因为发送端不需要安全上下文 |
| 接收端（Win11） | 新版 Chrome / Edge（推荐）、Firefox | Chrome / Edge 走 `MediaStreamTrackProcessor`，窗口被遮挡也能继续解码。Firefox 走 `<video>` 取帧，接收端窗口需要保持可见 |

### 安全上下文（重要）

浏览器只允许在 **安全上下文** 中使用 `getDisplayMedia` 和摄像头：

- ✅ `file:///.../cimbar-recv.html`（直接双击打开）
- ✅ `http://localhost:端口/...`、`http://127.0.0.1:端口/...`
- ✅ `https://...`
- ❌ `http://192.168.x.x:端口/...`：接收端页面会显示红色提示，并禁用按钮。如果确实需要通过局域网 IP 访问，可以：
  - 给 Chrome / Edge 加启动参数 `--unsafely-treat-insecure-origin-as-secure=http://192.168.x.x:端口`；或者
  - 打开 `chrome://flags/#unsafely-treat-insecure-origin-as-secure`，添加该地址，然后重启浏览器。

发送端不受这个限制，所以虚拟机通过 `http://宿主机IP` 访问发送端没有问题。

## 常见问题

**发送端提示“浏览器未启用 WebGL”**
虚拟机通常没有 3D 加速，可以尝试以下方法：① 在虚拟机设置里开启“3D 图形加速”；② Chrome 打开 `chrome://flags`，启用 *Override software rendering list*；③ Firefox 打开 `about:config`，把 `webgl.force-enabled` 设为 `true`。

**发送端提示“浏览器版本过旧”**
新版 emscripten 胶水代码用到了 `?.`、`??=`、class 字段和 BigInt 等语法，请升级到 Chrome 109 / Firefox ESR 115，或者使用 Supermium。

**接收端一直显示“等待发送端画面”**
- 确认分享的是虚拟机窗口，而且这个窗口没有被最小化。
- 把发送端帧率调低到 10，并尽量放大虚拟机窗口。
- 如果分享单个窗口不行，可以改为分享“整个屏幕”。
- 不要分享接收端自己所在的浏览器窗口，否则会出现“镜中镜”。

**屏幕共享的弹窗没有出现 / 直接报“拒绝”**
检查浏览器设置 → 隐私和安全 → 网站设置 → 屏幕共享，以及系统或企业策略是否禁用了屏幕捕获。

## 开发

```
src/            页面源码（基于 libcimbar web/ 修改）
  send.html     发送端页面        main.js / send.js
  recv.html     接收端页面        recv.js / recv-worker.js / zstd.js
  env.js        环境检测 + 内嵌 WASM 加载（两个页面共用）
vendor/         libcimbar 官方 release 的 cimbar_js.js / cimbar_js.wasm（v0.6.8）
tools/build.py  打包成 dist/ 下的单文件 HTML（只用到 Python 标准库）
tools/fetch_vendor.sh  重新下载 vendor/ 下的文件
test/e2e.js     端到端测试（Playwright）
```

```bash
python3 tools/build.py                      # 重新生成 dist/
LANG=C.UTF-8 node test/e2e.js 300000        # 端到端测试：发送 300KB 随机文件（中文文件名），校验接收结果逐字节一致
```

端到端测试流程：用无头 Chromium 打开发送端编码文件，连续截图，再通过 `canvas.captureStream()` 伪造一个 `getDisplayMedia` 流喂给接收端，最后比对下载下来的文件和原文件。

### 实现要点

- **WASM 只编译一次**：主线程从内嵌的 base64 编译出 `WebAssembly.Module`，再通过 `postMessage` 发给各个解码 worker，配合 emscripten 的 `Module.instantiateWasm` 钩子完成实例化。
- **worker 使用 Blob URL**：worker 源码（已拼接 emscripten 胶水代码）内嵌在 `<script type="text/plain">` 中，所以在 `file://` 下也能创建 worker。
- 屏幕捕获参数：`getDisplayMedia({ video: { cursor: "never", displaySurface: "window", frameRate: 30 }, audio: false, selfBrowserSurface: "exclude" })`。如果浏览器不认识部分约束，会自动退回 `{ video: true }` 再试一次。

## 许可证

本项目基于 libcimbar 修改，沿用 [MPL-2.0](LICENSE)。`vendor/` 下的文件来自 [libcimbar release v0.6.8](https://github.com/sz3/libcimbar/releases/tag/v0.6.8)，原样分发（只把内部引用的 wasm 文件名改为 `cimbar_js.wasm`）。
