// 运行环境检测 + 内嵌 WASM 加载（发送端/接收端共用）
// 构建后 cimbar_js.wasm 以 base64 形式内嵌在 #cimbar-wasm-b64 中，
// 因此页面可以直接从 file:// 打开，不依赖 fetch。
var CimbarEnv = function () {

  var _modulePromise = undefined;

  function b64ToBytes(b64) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    return bytes;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // public interface
  return {
    escapeHtml: escapeHtml,

    // 编译一次 WebAssembly.Module，主线程与各个 worker 共享
    wasmModule: function () {
      if (!_modulePromise) {
        _modulePromise = new Promise(function (resolve, reject) {
          var el = document.getElementById('cimbar-wasm-b64');
          if (!el || !el.textContent.trim()) {
            reject(new Error('页面中没有内嵌的 WASM 数据，请使用 dist/ 目录下构建好的 HTML 文件'));
            return;
          }
          resolve(b64ToBytes(el.textContent.trim()));
        }).then(function (bytes) {
          return WebAssembly.compile(bytes);
        });
      }
      return _modulePromise;
    },

    // emscripten 的 Module.instantiateWasm 钩子
    instantiateWasm: function (imports, successCallback) {
      CimbarEnv.wasmModule().then(function (mod) {
        return WebAssembly.instantiate(mod, imports).then(function (inst) {
          successCallback(inst, mod);
        });
      }).catch(function (e) {
        CimbarEnv.fatal('解码/编码核心（WASM）加载失败', String(e && e.message || e));
      });
      return {};
    },

    // 从内嵌的 <script type="text/plain"> 创建 worker（file:// 下也能用）
    createWorker: function (id) {
      var src = document.getElementById(id).textContent;
      var url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      return new Worker(url);
    },

    // 新版 emscripten 胶水代码需要的语法：?. ?? ??= class 字段 BigInt
    syntaxSupported: function () {
      try {
        new Function('var a = {}; a?.b; var c; c ??= 1; class X { y = 1 }; return 1n;');
        return typeof BigInt !== 'undefined';
      } catch (e) {
        return false;
      }
    },

    webglSupported: function () {
      try {
        var c = document.createElement('canvas');
        return !!(c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl'));
      } catch (e) {
        return false;
      }
    },

    // 浏览器内核大致信息，用于提示
    browserInfo: function () {
      var ua = navigator.userAgent;
      var m = ua.match(/(Edg|Chrome|Firefox|Supermium)\/(\d+)/);
      return m ? (m[1] + ' ' + m[2]) : ua;
    },

    fatal: function (title, detailHtml) {
      var box = document.getElementById('fatal');
      if (!box) {
        alert(title + '\n' + detailHtml);
        return;
      }
      box.innerHTML = '<h2>⚠️ ' + escapeHtml(title) + '</h2><div>' + detailHtml + '</div>' +
        '<p class="fatal-ua">浏览器：' + escapeHtml(navigator.userAgent) + '</p>';
      box.classList.add('show');
    },

    // 页面加载早期就挂上，防止胶水代码语法错误时页面“静默白屏”
    installErrorHandler: function () {
      window.addEventListener('error', function (e) {
        if (e && e.message && /SyntaxError|Unexpected token|expected expression/i.test(e.message)) {
          CimbarEnv.fatal('浏览器版本过旧，无法运行',
            '请升级到 Win7 可用的最后版本：<b>Chrome 109</b> / <b>Firefox ESR 115</b>，或使用 <b>Supermium</b>。<br>错误信息：' +
            escapeHtml(e.message));
        }
      });
    }
  };
}();
CimbarEnv.installErrorHandler();
