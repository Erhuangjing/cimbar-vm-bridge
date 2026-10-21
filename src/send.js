
var Send = function () {
  // the canvas
  var _ctx = undefined;
  var _canvas = undefined; // set by init

  // configurable
  var _interval = 66;
  var _colorBalance = false;

  // internal
  var _pause = 0;
  var _showStats = false;
  var _counter = 0;
  var _renderTime = 0;

  // 实际发送帧率统计（虚拟机里软件渲染可能达不到设定值）
  var _fpsWindowStart = 0;
  var _fpsWindowFrames = 0;
  // 各模式每帧的有效载荷（字节），用于估算发送速度
  var _bytesPerFrame = { 4: 7500, 66: 3240, 67: 5148, 68: 7500 };
  var _modeVal = 68;

  var _lastFrame = 0; // used with _interval
  var _wakeLock = undefined;

  // cached
  var _idealRatio = 1;
  var _compressBuff = undefined;

  function compress_buff(chunkSize) {
    if (_compressBuff === undefined) {
      const dataPtr = Module._malloc(chunkSize);
      _compressBuff = new Uint8Array(Module.HEAPU8.buffer, dataPtr, chunkSize);
    }
    else if (_compressBuff.buffer !== Module.HEAPU8.buffer) {
      _compressBuff = new Uint8Array(Module.HEAPU8.buffer, _compressBuff.byteOffset, _compressBuff.byteLength);
    }
    return _compressBuff;
  }

  function importFile(file) {
    let chunkSize = Module._cimbare_encode_bufsize() * 16;
    let compBuff = compress_buff(chunkSize);

    let offset = 0;
    let reader = new FileReader();

    Send.encode_init(file.name);

    reader.onload = function (event) {
      const datalen = event.target.result.byteLength;
      if (datalen > 0) {
        // copy to wasm buff and write
        const uint8View = new Uint8Array(event.target.result);
        compBuff = compress_buff(chunkSize);
        compBuff.set(uint8View);
        const buffView = new Uint8Array(Module.HEAPU8.buffer, compBuff.byteOffset, datalen);
        Send.encode_bytes(buffView);

        offset += chunkSize;
        readNext();
      } else {
        // Done reading file
        console.log("Finished reading file.");

        // this null call is functionally a flush()
        // so a no-op, unless it isn't
        const nullBuff = new Uint8Array(Module.HEAPU8.buffer, compBuff.byteOffset, 0);
        Send.encode_bytes(nullBuff);
      }
    };

    function readNext() {
      let slice = file.slice(offset, offset + chunkSize);
      reader.readAsArrayBuffer(slice);
    }

    readNext();
  }

  function copyToWasmHeap(abuff) {
    const dataPtr = Module._malloc(abuff.length);
    const wasmData = new Uint8Array(Module.HEAPU8.buffer, dataPtr, abuff.length);
    wasmData.set(abuff);
    return wasmData;
  }

  // public interface
  return {
    init_window: function (canvas) {
      _canvas = canvas;
      Module._cimbare_init_window(0, 0);
    },

    importFile: function (file) {
      importFile(file);
    },

    togglePause: function (pause) {
      // pause is a cooldown. We pause to help autofocus, but we don't want to do it forever...
      if (pause === undefined) {
        pause = !Send.isPaused();
      }
      _pause = pause ? 15 : 0;
    },

    isPaused: function () {
      return _pause > 0;
    },

    rotate_window: function (needRotate) {
      Module._cimbare_rotate_window(needRotate);
    },

    encode_init: function (filename) {
      console.log("encoding " + filename);
      const wasmFn = copyToWasmHeap(new TextEncoder("utf-8").encode(filename));
      try {
        var res = Module._cimbare_init_encode(wasmFn.byteOffset, wasmFn.length, -1);
        console.log("init_encode returned " + res);
      } finally {
        Module._free(wasmFn.byteOffset);
      }

      Report.setTitle(filename);
      Report.setHTML("current-file", filename);
    },

    encode_bytes: function (wasmData) {
      var res = Module._cimbare_encode(wasmData.byteOffset, wasmData.length);
      console.log("encode returned " + res);

      if (res == 0) {
        Report.setActive();
      }
    },

    nextFrame: function (timestamp) {
      //console.log("in nextFrame, is it happening?");
      window.requestAnimationFrame(Send.nextFrame);
      let elapsed = timestamp - _lastFrame;
      // 留半帧（约 8ms）容差，并按平均间隔累计，
      // 这样 60Hz 屏幕上 25 帧/秒之类的设定也能达到平均值，而不是被量化成 20
      if (!timestamp || elapsed < _interval - 8) {
        return;
      }
      _lastFrame = elapsed > 2 * _interval ? timestamp : _lastFrame + _interval;

      _counter += 1;
      if (_pause > 0) {
        _pause -= 1;
      }
      if (!Send.isPaused()) {
        Module._cimbare_render();
        var frameCount = Module._cimbare_next_frame(_colorBalance);
      }

      if (frameCount && !Send.isPaused()) {
        Send.update_fps(timestamp);
      }

      if (_showStats && frameCount) {
        _renderTime += elapsed;
        Report.setHTML("status", elapsed + " : " + frameCount + " : " + Math.ceil(_renderTime / frameCount));
      }

      if (!Send.isPaused() && _counter % 16 == 0) {
        Report.prevent_sleep();
      }
    },

    setMode: function (mode_val) {
      // call resize after this from Main?
      _modeVal = mode_val;
      Module._cimbare_configure(mode_val, -1);
      Report.setAspectRatio(Module._cimbare_get_aspect_ratio());
    },

    update_fps: function (timestamp) {
      _fpsWindowFrames += 1;
      if (!_fpsWindowStart) {
        _fpsWindowStart = timestamp;
        return;
      }
      const span = timestamp - _fpsWindowStart;
      if (span < 2000) {
        return;
      }
      const actual = (_fpsWindowFrames - 1) * 1000 / span;
      const target = 1000 / _interval;
      let msg = actual.toFixed(1) + " / " + Math.round(target) + " 帧/秒<br>约 " + Math.round(actual * (_bytesPerFrame[_modeVal] || 7500) / 1024) + " KB/s";
      if (actual < target * 0.85) {
        msg += "<br>⚠️ 渲染跟不上";
      }
      Report.setHTML("status", msg);
      _fpsWindowStart = timestamp;
      _fpsWindowFrames = 1;
    },

    setFPS: function (val) {
      if (!val) {
        return;
      }
      _interval = Math.floor(1000 / val);
      console.log("new frame delay interval is " + _interval);
    }
  };
}();
