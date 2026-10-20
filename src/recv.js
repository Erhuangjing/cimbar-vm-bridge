var Sink = function () {

  var _fountainBuff = undefined;
  var _errBuff = undefined;
  var _errBuffSize = 1024;
  var _completed = {};

  function fountain_buff() {
    if (_fountainBuff.buffer !== Module.HEAPU8.buffer) {
      _fountainBuff = new Uint8Array(Module.HEAPU8.buffer, _fountainBuff.byteOffset, _fountainBuff.byteLength);
    }
    return _fountainBuff;
  }

  // public interface
  return {
    allocate: function () {
      const size = Module._cimbard_get_bufsize(); // max length of buff. We could also resize as we go...
      if (_fountainBuff && size > _fountainBuff.length) {
        Module._free(_fountainBuff.byteOffset);
        _fountainBuff = undefined;
      }
      if (_fountainBuff === undefined) {
        const dataPtr = Module._malloc(size);
        _fountainBuff = new Uint8Array(Module.HEAPU8.buffer, dataPtr, size);
      }
    },

    reset_completed: function () {
      _completed = {};
    },

    on_decode: function (buff) {
      if (buff.length == 0) { // sanity check
        return;
      }
      const fountBuff = fountain_buff();
      fountBuff.set(buff);

      var res = Module._cimbard_fountain_decode(fountBuff.byteOffset, buff.length);
      console.log("on decode got res " + res);

      const report = Sink.get_report();
      if (Array.isArray(report)) {
        Recv.render_progress(report);
      }
      else {
        Recv.set_HTML("tdec", "decode " + res + ". " + report);
      }

      if (res > 0) {
        const res32t = Number(res & 0xFFFFFFFFn); // truncate BigInt res (int64_t) to a uint32_t
        if (_completed[res32t]) { // 同一个文件已经保存过，不再重复下载
          return;
        }
        _completed[res32t] = true;
        Sink.reassemble_file(res32t);
      }
    },

    get_report: function () {
      if (_errBuff === undefined) {
        _errBuff = Module._malloc(_errBuffSize);
      }
      const errlen = Module._cimbard_get_report(_errBuff, _errBuffSize);
      if (errlen > 0) {
        const errview = new Uint8Array(Module.HEAPU8.buffer, _errBuff, errlen);
        const td = new TextDecoder();
        const text = td.decode(errview);
        try {
          return JSON.parse(text);
        } catch (error) {
          return text;
        }
      }
    },

    reassemble_file: function (id) {
      const size = Module._cimbard_get_filesize(id);
      try {
        var name = id + "." + size;
        const fnsize = Module._cimbard_get_filename(id, _errBuff, _errBuffSize);
        if (fnsize < 0) {
          console.log("reassemble_file failed. :( " + fnsize);
          Recv.set_HTML("errorbox", "reassemble_file failed :( " + fnsize);
          Recv.toast("文件重组失败（错误码 " + fnsize + "），请重新发送", "error");
        }
        else if (fnsize > 0) {
          const temparr = new Uint8Array(Module.HEAPU8.buffer, _errBuff, fnsize);
          name = new TextDecoder("utf-8").decode(temparr);
        }
        Zstd.decompress(name, id);
      } catch (error) {
        console.log("failed finish copy or download?? " + error);
        Recv.toast("保存文件失败：" + error, "error");
      }
    }
  };
}();


var Recv = function () {

  var _counter = 0;
  var _recentDecode = -1;
  var _recentExtract = -1;
  var _captureNextFrame = 0;

  var _watchmanTimer = undefined;
  var _watchmanLastSeen = 1; // start at 1, can't restart if we never started

  var _video = 0;
  var _useVideoFrame = true;
  var _vfcId = undefined;

  // 输入源：'camera' | 'screen' | undefined
  var _source = undefined;
  // 每次切换输入源 +1，旧的取帧循环看到编号变化后自行退出
  var _generation = 0;
  var _trackReader = undefined;
  var _wasmReady = false;
  var _visualState = "";

  var _workers = [];
  var _nextWorker = 0;
  var _workerReady;
  var _framesInFlight = 0;
  var _maxFramesInFlight = 8;
  var _supportedFormats = ["NV12", "I420"]; // have cimbard_* return this somehow?

  var _mode = 0;

  function _requestVideoFrame(callback) {
    if ('requestVideoFrameCallback' in _video) {
      _vfcId = _video.requestVideoFrameCallback(callback);
    } else {
      _vfcId = requestAnimationFrame(function (now) {
        return callback(now, {});
      });
    }
  }

  function _cancelVideoFrameCallback() {
    if (_video && _vfcId !== undefined) {
      if ('cancelVideoFrameCallback' in _video) {
        _video.cancelVideoFrameCallback(_vfcId);
      } else {
        cancelAnimationFrame(_vfcId);
      }
      _vfcId = undefined;
    }
  }

  function _toggleFullscreen() {
    if (document.fullscreenElement) {
      return document.exitFullscreen();
    }
    else {
      return document.documentElement.requestFullscreen();
    }
  }

  function isIOS() {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    const isAppleDevice = navigator.userAgent.includes('Macintosh');
    const isTouchScreen = navigator.maxTouchPoints >= 1;
    return isIOS || (isAppleDevice && isTouchScreen);
  }

  function _getModeAspectRatio(mode) {
    // (image_size_x + 16) / (image_size_y + 16)
    switch (mode) {
      case 66: return 1.1516; // Bu
      case 67: return 1.413;  // Bm
      default: return 1.0;    // B, 4C, auto
    }
  }

  function _updateCrosshairPositions() {
    if (!_video || !_video.videoWidth || !_video.videoHeight)
      return;

    var modeAspect = _getModeAspectRatio(_mode);

    var windowW = window.innerWidth;
    var windowH = window.innerHeight;
    var camAspect = _video.videoWidth / _video.videoHeight;
    var windowAspect = windowW / windowH;

    var vidW = windowW;
    var vidH = windowH;
    if (camAspect > windowAspect)  // black bars top/bottom
      vidH = vidW / camAspect;
    else  // black bars left/right
      vidW = vidH * camAspect;

    var offsetY;
    var offsetX;
    if (windowH > windowW) {
      // portrait
      offsetY = (windowH - (vidW * modeAspect)) / 2;
      offsetX = (windowW - vidW) / 2;
    }
    else {
      offsetY = (windowH - vidH) / 2;
      offsetX = (windowW - (vidH * modeAspect)) / 2;
    }

    var xh1 = document.getElementById("crosshair1");
    var xh2 = document.getElementById("crosshair2");
    xh1.style.top = offsetY + "px";
    xh1.style.right = offsetX + "px";
    xh2.style.bottom = offsetY + "px";
    xh2.style.left = offsetX + "px";
  }

  function _formatSize(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + " MB";
    return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
  }

  // getUserMedia / getDisplayMedia 的错误 -> 中文说明
  function _describeMediaError(err, source) {
    const what = source == 'screen' ? '屏幕捕获' : '摄像头';
    const name = err && err.name;
    if (name == 'NotAllowedError' || name == 'PermissionDeniedError') {
      if (source == 'screen') {
        return '你取消了共享，或浏览器/系统拒绝了屏幕捕获权限。<br>' +
          '请重新点击「捕获屏幕/窗口」，在弹窗中选中虚拟机窗口后点「分享」。<br>' +
          '若弹窗根本没有出现：检查浏览器设置 → 隐私和安全 → 网站设置 → 屏幕共享（或企业策略）是否被禁用。';
      }
      return '摄像头权限被拒绝。请点击地址栏左侧的图标，允许本页面使用摄像头，然后重试。';
    }
    if (name == 'NotFoundError' || name == 'DevicesNotFoundError') {
      return '没有找到可用的' + (source == 'screen' ? '屏幕或窗口' : '摄像头') + '。';
    }
    if (name == 'NotReadableError' || name == 'TrackStartError' || name == 'AbortError') {
      return '无法读取' + what + '：设备可能正被其他程序占用，或被系统阻止。';
    }
    if (name == 'SecurityError') {
      return '安全限制：' + what + '只能在安全上下文中使用（file://、http://localhost 或 https://）。';
    }
    return what + '启动失败：' + CimbarEnv.escapeHtml(String(err));
  }

  function _requestStream(source) {
    if (source == 'screen') {
      const constraints = {
        video: {
          cursor: "never",           // 旧写法，部分浏览器仍识别
          frameRate: { ideal: 30, max: 30 },
          width: { ideal: 3840 },
          height: { ideal: 2160 },
          displaySurface: "window",  // 弹窗里优先展示“窗口”标签页
        },
        audio: false,
        selfBrowserSurface: "exclude", // 不要捕获本页自身，避免“镜中镜”
        surfaceSwitching: "include",
        monitorTypeSurfaces: "include",
      };
      return navigator.mediaDevices.getDisplayMedia(constraints).catch(err => {
        // 老浏览器可能不认识部分约束，退回最简单的写法再试一次
        if (err && (err.name == 'TypeError' || err.name == 'OverconstrainedError')) {
          return navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        }
        throw err;
      });
    }

    const constraints = {
      audio: false,
      video: {
        width: { min: 720, ideal: 1920 },
        height: { min: 720, ideal: 1080 },
        aspectRatio: matchMedia('all and (orientation:landscape)').matches ? 16 / 9 : 9 / 16,
        facingMode: 'environment',
        exposureMode: 'continuous',
        focusMode: 'continuous',
        frameRate: { ideal: 15 }, // we're not trying to set the user's phone on fire
      }
    };
    return navigator.mediaDevices.getUserMedia(constraints).catch(err => {
      // 虚拟摄像头（OBS 等）经常不满足 min 分辨率约束，放宽后重试
      if (err && (err.name == 'OverconstrainedError' || err.name == 'ConstraintNotSatisfiedError' || err.name == 'TypeError')) {
        return navigator.mediaDevices.getUserMedia({ audio: false, video: { width: { ideal: 1920 }, height: { ideal: 1080 } } });
      }
      throw err;
    });
  }

  // 用 MediaStreamTrackProcessor 直接从轨道取帧：
  // 不依赖 <video> 渲染，接收端窗口被虚拟机窗口挡住/切到后台时也能继续解码
  async function _pumpTrack(track, generation) {
    const processor = new MediaStreamTrackProcessor({ track: track });
    const reader = processor.readable.getReader();
    _trackReader = reader;
    while (generation == _generation) {
      let res;
      try {
        res = await reader.read();
      } catch (e) {
        break;
      }
      if (res.done) {
        break;
      }
      const vf = res.value;
      if (generation != _generation || _framesInFlight >= _maxFramesInFlight) {
        vf.close();
        continue;
      }
      try {
        await Recv.process_frame(vf, performance.now());
      } catch (e) {
        console.error(e);
      } finally {
        vf.close();
      }
    }
    try {
      reader.releaseLock();
    } catch (e) { }
  }

  // public interface
  return {
    init: function (video, num_workers) {
      Recv.init_ww(num_workers);
      _video = video;
    },

    set_error: function (msg) {
      Recv.set_HTML('errorbox', msg);
      return false;
    },

    ww_ready: new Promise(resolve => {
      _workerReady = resolve;
    }),

    frames_in_flight_incr: function () {
      _framesInFlight += 1;
      document.getElementById('framesInFlight').innerHTML = _framesInFlight + "  " + _useVideoFrame;
    },

    frames_in_flight_decr: function () {
      _framesInFlight -= 1;
      document.getElementById('framesInFlight').innerHTML = _framesInFlight + "  " + _useVideoFrame;
    },

    init_ww: function (num_workers) {
      // clean up _workers if exists
      for (const wkr of _workers) {
        try {
          wkr.terminate();
        } catch (e) { }
      }
      _workers = [];

      for (let i = 0; i < num_workers; i++) {
        _workers.push(CimbarEnv.createWorker('recv-worker-src'));

        _workers[i].onmessage = (event) => {
          Recv.on_decode(i, event.data);
        };

        _workers[i].onerror = (error) => {
          console.error('Worker' + i + ' error:', error);
        };
      }

      CimbarEnv.wasmModule().then(mod => {
        for (const wkr of _workers) {
          wkr.postMessage({ type: 'wasmModule', module: mod });
        }
      });
    },

    on_wasm_ready: function () {
      _wasmReady = true;
      Recv.update_source_buttons();
    },

    // 环境检测：返回问题列表（中文 HTML）
    check_environment: function () {
      const problems = [];
      const md = navigator.mediaDevices;
      if (!window.isSecureContext) {
        problems.push('当前地址 <code>' + CimbarEnv.escapeHtml(location.origin) + '</code> 不是“安全上下文”，浏览器会禁用屏幕捕获和摄像头。<br>' +
          '解决办法（任选其一）：<br>' +
          '① 直接双击本地的 <code>cimbar-recv.html</code> 用浏览器打开（file:// 属于安全上下文）；<br>' +
          '② 在本机用 <code>http://localhost:端口/cimbar-recv.html</code> 或 <code>http://127.0.0.1:端口/...</code> 访问；<br>' +
          '③ 必须用局域网 IP 访问时，启动 Chrome/Edge 加参数 <code>--unsafely-treat-insecure-origin-as-secure=' +
          CimbarEnv.escapeHtml(location.origin) + '</code>，或在 <code>chrome://flags/#unsafely-treat-insecure-origin-as-secure</code> 中添加该地址。');
      }
      else if (!md || !md.getDisplayMedia) {
        problems.push('当前浏览器不支持屏幕捕获（getDisplayMedia）。请在 Win11 上使用新版 Chrome / Edge / Firefox。');
      }
      if (typeof WebAssembly === 'undefined') {
        problems.push('当前浏览器不支持 WebAssembly，无法解码。');
      }
      if (typeof VideoFrame === 'undefined' && typeof OffscreenCanvas === 'undefined') {
        problems.push('当前浏览器既不支持 VideoFrame 也不支持 OffscreenCanvas，无法把画面送入解码器。请升级浏览器。');
      }
      return problems;
    },

    update_source_buttons: function () {
      const md = navigator.mediaDevices;
      const screenBtn = document.getElementById('btn-screen');
      const camBtn = document.getElementById('btn-camera');
      screenBtn.disabled = !_wasmReady || !md || !md.getDisplayMedia;
      camBtn.disabled = !_wasmReady || !md || !md.getUserMedia;
      Recv.set_HTML('loading-status', _wasmReady ? '✅ 解码核心已就绪，请选择输入源' : '⏳ 正在加载解码核心…');
    },

    show_source_picker: function (msgHtml, isError) {
      Recv.stop_camera();
      _source = undefined;
      document.body.classList.remove('source-screen', 'source-camera', 'running');
      document.getElementById('picker').classList.remove('hidden');
      const box = document.getElementById('picker-msg');
      box.innerHTML = msgHtml || '';
      box.className = msgHtml ? (isError ? 'msg error' : 'msg') : 'msg hidden';
      Recv.blurNav();
    },

    // 按钮点击入口：必须在用户点击的同步调用栈里调用 getDisplayMedia
    start: function (source) {
      Recv.stop_camera();
      const md = navigator.mediaDevices;
      if (!md || (source == 'screen' ? !md.getDisplayMedia : !md.getUserMedia)) {
        Recv.show_source_picker(Recv.check_environment().join('<br><br>') || '浏览器不支持该输入源。', true);
        return;
      }

      const generation = ++_generation;
      Recv.set_HTML('picker-msg', source == 'screen' ? '请在浏览器弹窗中选择<b>虚拟机窗口</b>…' : '正在打开摄像头…');
      document.getElementById('picker-msg').className = 'msg';

      _requestStream(source)
        .then(stream => {
          if (generation != _generation) {
            stream.getTracks().forEach(track => track.stop());
            return;
          }
          Recv.attach_stream(stream, source, generation);
        })
        .catch(err => {
          console.error('getMedia failed', err);
          Recv.set_error((source == 'screen' ? "屏幕捕获失败：" : "摄像头初始化失败：") + err);
          Recv.show_source_picker(_describeMediaError(err, source), true);
        });
    },

    attach_stream: function (stream, source, generation) {
      const video = _video;
      _source = source;
      _counter = 0;
      _recentDecode = -1;
      _recentExtract = -1;
      _watchmanLastSeen = 1;
      _visualState = "";
      Sink.reset_completed();

      document.getElementById('picker').classList.add('hidden');
      document.body.classList.add('running', source == 'screen' ? 'source-screen' : 'source-camera');

      if ('srcObject' in video) {
        video.srcObject = stream;
      } else {
        video.src = URL.createObjectURL(stream); //deprecated
      }
      video.play().catch(err => {
        console.log("video.play() failed: " + err);
      });

      const track = stream.getVideoTracks()[0];
      if (track) {
        // 用户点了浏览器的「停止共享」，或虚拟机窗口被关闭
        track.addEventListener('ended', () => {
          if (generation == _generation) {
            Recv.show_source_picker(source == 'screen' ? '屏幕共享已停止。需要继续接收时，请重新选择输入源。' : '摄像头已断开。');
          }
        });
        try {
          const s = track.getSettings();
          Recv.set_HTML('t3', 'source ' + source + ' ' + s.width + 'x' + s.height + ' @' + s.frameRate);
        } catch (e) { }
      }

      if (source == 'screen' && track && typeof MediaStreamTrackProcessor !== 'undefined' && typeof VideoFrame !== 'undefined') {
        _pumpTrack(track, generation);
      }
      else {
        _requestVideoFrame(Recv.on_frame);
      }
      Recv.toast(source == 'screen' ? '开始捕获屏幕，等待发送端画面…' : '摄像头已开启，请对准发送端画面');
    },

    // 兼容旧接口：直接用摄像头启动
    init_video: function (video) {
      _video = video;
      Recv.start('camera');
    },

    stop_camera: function () {
      _generation += 1;
      _cancelVideoFrameCallback();
      if (_trackReader) {
        try {
          _trackReader.cancel();
        } catch (e) { }
        _trackReader = undefined;
      }
      if (_video && _video.srcObject) {
        _video.srcObject.getTracks().forEach(track => track.stop());
        _video.srcObject = null;
      }

      if (_watchmanTimer > 0) {
        clearInterval(_watchmanTimer);
      }
      _watchmanTimer = 0;
    },

    watch_for_camera_pause: function () {
      // only call this after our first success
      if (_watchmanTimer) {
        return;
      }

      // ios only for now, since desktop behavior is weird
      if (!isIOS() || _source != 'camera') {
        _watchmanTimer = -1; // lol
        return;
      }

      // periodically make sure the camera capture is running
      _watchmanTimer = setInterval(Recv.restart_paused_camera, 1000);
    },

    restart_paused_camera: function () {
      if (!_video) {
        return;
      }

      // if we're still incrementing, do nothing
      if (_counter > _watchmanLastSeen) {
        _watchmanLastSeen = _counter;
        return;
      }

      // if not, we're stuck?
      clearInterval(_watchmanTimer); // our work is done, for now
      _watchmanTimer = 0;
      Recv.start('camera');
    },

    download_bytes: function (buff, name) {
      var blob = new Blob([buff], { type: 'application/octet-stream' });
      Zstd.download_blob(name, blob);
    },

    on_decode: function (wid, data) {
      if (data.type == 'startWasm') {
        if (data.ready && _workerReady) {
          _workerReady();
        }
        if (data.error) {
          Recv.set_error("worker " + wid + " 加载失败：" + data.error);
        }
        return;
      }

      Recv.frames_in_flight_decr();
      // if extract but no bytes, log extract counter
      if (data.nodata) {
        _recentExtract = _counter;
        return;
      }
      if (data.failed_extract) { // very common, nothing to do
        return;
      }
      if (data.res) {
        Recv.set_HTML("t" + wid, "msg is " + data.res);
        return;
      }
      if (data.error) {
        // other error cases
        console.log("on_decode error? " + data.error);
        return;
      }

      // should be a decode with some bytes, so set decodecounter
      _recentDecode = _counter;

      const buff = data.buff;
      if (buff.length > 0) {
        Recv.setMode(data.mode); // call *before* we send it to the sink. This is our autodetect confirm.
      }
      Recv.set_HTML("t" + wid, "mode is " + _mode + ", len() is " + buff.length);
      Sink.on_decode(buff);
    },

    // VideoFrame -> worker 消息（像素拷贝到普通内存）
    frame_to_msg: async function (vf) {
      const width = vf.visibleRect ? vf.visibleRect.width : vf.displayWidth;
      const height = vf.visibleRect ? vf.visibleRect.height : vf.displayHeight;
      Recv.set_HTML("errorbox", vf.format, true);

      // try to use the default format, but only if we can decode it...
      let vfparams = {};
      if (!_supportedFormats.includes(vf.format)) {
        vfparams.format = "RGBA";
      }
      try {
        const size = vf.allocationSize(vfparams);
        const buff = new Uint8Array(size);
        await vf.copyTo(buff, vfparams);

        let format = vfparams.format || vf.format;
        if (format == "RGBA" && size != width * height * 4) {
          format = vf.format; //fallback
        }

        // debugging only
        if (_captureNextFrame == 1) {
          _captureNextFrame = 0;
          Recv.download_bytes(buff, width + "x" + height + "x" + _counter + "." + format);
        }

        return {
          type: 'proc',
          pixels: buff,
          format: format,
          width: width,
          height: height,
        };
      } catch (e) {
        // 浏览器不支持把该格式转换成 RGBA：改走 ImageBitmap，由 worker 用 OffscreenCanvas 转换
        const bitmap = await createImageBitmap(vf);
        return {
          type: 'proc',
          bitmap: bitmap,
          format: "RGBA",
          width: bitmap.width,
          height: bitmap.height,
        };
      }
    },

    process_frame: async function (vf) {
      const workerMsg = await Recv.frame_to_msg(vf);
      Recv.dispatch(workerMsg);
    },

    dispatch: function (workerMsg) {
      _counter += 1;
      if (_workers.length == 0)
        return;
      if (_nextWorker >= _workers.length)
        _nextWorker = 0;

      // piggyback off this call to make sure our visual state is correct
      Recv.update_visual_state();
      // make sure the camera feed stays up
      Recv.watch_for_camera_pause();

      const modeVals = [66, 68, 67, 4];
      workerMsg.mode = _mode || modeVals[_counter % modeVals.length];

      Recv.frames_in_flight_incr();
      try {
        if (workerMsg.pixels) {
          _workers[_nextWorker].postMessage(workerMsg, [workerMsg.pixels.buffer]);
        }
        else {
          _workers[_nextWorker].postMessage(workerMsg, [workerMsg.bitmap]);
        }
        _nextWorker += 1;
      }
      catch (e) {
        Recv.frames_in_flight_decr();
        if (workerMsg.bitmap) {
          workerMsg.bitmap.close();
        }
        throw e; // rethrow
      }
    },

    // <video> 驱动的取帧循环（摄像头，或不支持 MediaStreamTrackProcessor 的浏览器）
    on_frame: async function (now, metadata) {
      const generation = _generation;
      try {
        if (_framesInFlight > 20) {
          console.log("stalling, worker queues are full");
        }
        else if (_useVideoFrame) {
          let vf = undefined;
          try {
            vf = new VideoFrame(_video, { timestamp: Math.round(now * 1000) });
          } catch (e) {
            if (typeof VideoFrame === 'undefined') {
              console.log("no VideoFrame!");
              _useVideoFrame = false;
            }
          }
          if (vf) {
            try {
              await Recv.process_frame(vf);
            } finally {
              vf.close();
            }
          }
        }
        else if (_video.videoWidth && _video.videoHeight) {
          const bitmap = await createImageBitmap(_video);
          Recv.dispatch({
            type: 'proc',
            bitmap: bitmap,
            format: "RGBA",
            width: bitmap.width,
            height: bitmap.height,
          });
        }
      } catch (e) {
        console.error(e);
      }

      if (generation == _generation) {
        _requestVideoFrame(Recv.on_frame);
      }
    },

    captureFrame: function () {
      _captureNextFrame = 1;
      console.log("capturing next frame");
    },

    update_visual_state: function () {
      _updateCrosshairPositions();

      // check counters
      var state = "idle";
      if (_recentDecode > 0 && _recentDecode + 30 > _counter) {
        state = "active";
      }
      else if (_recentExtract > 0 && _recentExtract + 30 > _counter) {
        state = "scanning";
      }
      if (state == _visualState) {
        return;
      }
      _visualState = state;

      var xh1 = document.getElementById("crosshair1");
      var xh2 = document.getElementById("crosshair2");
      for (const xh of [xh1, xh2]) {
        xh.classList.toggle("active_xhairs", state == "active");
        xh.classList.toggle("scanning_xhairs", state == "scanning");
      }

      const pill = document.getElementById("status-pill");
      pill.className = "pill " + state;
      if (state == "active") {
        Recv.set_HTML("status-text", "正在接收数据");
      }
      else if (state == "scanning") {
        Recv.set_HTML("status-text", "已发现条码，正在对齐…");
      }
      else {
        Recv.set_HTML("status-text", _source == 'screen' ? "等待发送端画面（请确认已选中虚拟机窗口）" : "等待条码进入画面");
      }
    },

    render_progress: function (report) {
      Recv.set_HTML("tdec", "progress " + report);
      const progress_container = document.getElementById('progress_bars');
      const query = '#progress_bars > div[class="progress"]';
      const prev = document.querySelectorAll(query);

      if (!prev || prev.length < report.length) {
        for (var i = (prev ? prev.length : 0); i < report.length; i++) {
          var aaa = document.createElement('div');
          aaa.classList.add("progress");
          progress_container.appendChild(aaa);
        }
      }
      else if (report.length < prev.length) {
        for (var i = report.length; i < prev.length; i++) {
          prev[i].remove();
        }
      }

      const current = document.querySelectorAll(query);
      for (var i = 0; i < report.length; i++) {
        current[i].style.width = report[i] * 100 + "%";
      }

      if (report.length > 0) {
        const pct = Math.floor(Math.max.apply(null, report) * 100);
        Recv.set_HTML("status-progress", pct + "%");
      }
    },

    on_file_received: function (filename, blob) {
      Recv.set_HTML("status-progress", "");
      const list = document.getElementById('received-list');
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.textContent = filename;
      const meta = document.createElement('span');
      meta.textContent = " （" + _formatSize(blob.size) + "，" + new Date().toLocaleTimeString() + "）";
      li.appendChild(a);
      li.appendChild(meta);
      list.insertBefore(li, list.firstChild);
      document.getElementById('received').classList.remove('hidden');
      Recv.toast("✅ 接收完成：" + filename + "（" + _formatSize(blob.size) + "），已开始下载", "ok");
    },

    toast: function (msg, kind) {
      const box = document.getElementById('toasts');
      const div = document.createElement('div');
      div.className = 'toast ' + (kind || '');
      div.textContent = msg;
      box.appendChild(div);
      setTimeout(() => div.remove(), kind == 'error' ? 10000 : 5000);
    },

    toggleFullscreen: function () {
      _toggleFullscreen();
    },

    showDebug: function () {
      document.getElementById("debug-button").focus();
    },

    clickNav: function () {
      document.getElementById("nav-button").focus();
    },

    blurNav: function (pause) {
      document.getElementById("nav-button").blur();
      document.getElementById("nav-content").blur();
      if (document.activeElement && document.activeElement.blur) {
        document.activeElement.blur();
      }
    },

    setMode: function (modeVal) {
      // these should be moved elsewhere...
      const modeToString = {
        4: "4C",
        8: "8C",
        66: "Bu",
        67: "Bm",
        68: "B"
      };
      let modeStringToVal = {
        "Auto": 0
      };
      for (const val in modeToString) {
        modeStringToVal[modeToString[val]] = val;
      }

      if (modeVal in modeStringToVal) {
        modeVal = modeStringToVal[modeVal];
      }

      // configure wasm in main thread
      _mode = modeVal;
      if (_mode > 0) {
        Module._cimbard_configure_decode(_mode);
        Sink.allocate();
      }

      // update ui
      if (_mode > 0) {
        var nav = document.getElementById("mode-val");
        nav.innerHTML = modeToString[_mode];
      }

      var nav = document.getElementById("nav-container");
      if (_mode == 0) {
        nav.classList.add("mode-auto");
        nav.classList.remove("mode-b");
      } else {
        nav.classList.add("mode-b");
        nav.classList.remove("mode-auto");
      }
    },

    set_HTML: function (id, msg, only_if_unset) {
      const elem = document.getElementById(id);
      if (only_if_unset && elem.innerHTML) {
        return;
      }
      elem.innerHTML = msg;
    },

    set_title: function (msg) {
      document.title = "Cimbar 接收：" + msg;
    }
  };
}();
