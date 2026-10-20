// 端到端测试：发送端编码文件 -> 截图 -> 伪造的 getDisplayMedia 流 -> 接收端解码 -> 比对文件
// 用法：LANG=C.UTF-8 node test/e2e.js [文件大小字节数]   （Linux 下需 UTF-8 locale，否则中文下载名会变成 download）
const { chromium } = require('playwright');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIST = path.join(__dirname, '..', 'dist');
const size = parseInt(process.argv[2] || '40000', 10);

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cimbar-e2e-'));
  const name = '测试文件 (中文名).bin';
  const data = crypto.randomBytes(size);

  const browser = await chromium.launch({
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const ctx = await browser.newContext({ viewport: { width: 900, height: 900 }, acceptDownloads: true });

  const errors = [];
  const send = await ctx.newPage();
  send.on('pageerror', e => errors.push('send: ' + e));
  await send.goto('file://' + path.join(DIST, 'cimbar-send.html'));
  await send.waitForFunction(() => typeof Module !== 'undefined' && Module.calledRun);
  if (await send.$eval('#fatal', el => el.classList.contains('show'))) {
    throw new Error('sender fatal: ' + await send.$eval('#fatal', el => el.textContent));
  }
  // 注意：playwright 的 setInputFiles 遇到中文路径不会触发 onchange，所以直接构造 File
  await send.evaluate(([b64, fname]) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    Main.importFile(new File([bytes], fname));
  }, [data.toString('base64'), name]);
  await send.waitForTimeout(1000);
  await send.evaluate(() => Main.blurNav(false));

  const recv = await ctx.newPage();
  recv.on('pageerror', e => errors.push('recv: ' + e));
  // 用 canvas.captureStream 冒充屏幕捕获
  await recv.addInitScript(() => {
    navigator.mediaDevices.getDisplayMedia = async function () {
      const c = document.createElement('canvas');
      c.width = 900; c.height = 900;
      window.__fakeCanvas = c;
      window.__fakeCtx = c.getContext('2d');
      return c.captureStream(30);
    };
  });
  await recv.goto('file://' + path.join(DIST, 'cimbar-recv.html'));
  await recv.waitForFunction(() => !document.getElementById('btn-screen').disabled, null, { timeout: 30000 });
  const warn = await recv.$eval('#env-warnings', el => el.classList.contains('hidden') ? '' : el.textContent);
  console.log('env warnings:', warn || '(none)');
  await recv.click('#btn-screen');
  await recv.waitForFunction(() => document.getElementById('picker').classList.contains('hidden'));

  const download = recv.waitForEvent('download', { timeout: 120000 });
  let done = false;
  download.then(() => { done = true; }, () => { done = true; });

  let frames = 0;
  while (!done && frames < 600) {
    const png = (await send.locator('#canvas').screenshot()).toString('base64');
    await recv.evaluate(async (b64) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const ctx = window.__fakeCtx;
      ctx.fillStyle = '#333';
      ctx.fillRect(0, 0, 900, 900);
      ctx.drawImage(img, 50, 50, 800, 800);
    }, png);
    frames++;
    if (frames % 10 == 0) {
      console.log('frames fed', frames, await recv.$eval('#status-pill', el => el.textContent));
    }
  }

  const dl = await download;
  const out = path.join(tmp, 'out.bin');
  await dl.saveAs(out);
  const got = fs.readFileSync(out);
  console.log('received', dl.suggestedFilename(), got.length, 'bytes after', frames, 'frames');
  console.log('received list:', await recv.$eval('#received-list', el => el.textContent));
  if (errors.length) console.log('page errors:', errors);
  await recv.screenshot({ path: path.join(__dirname, 'recv-screenshot.png') });
  await browser.close();
  if (dl.suggestedFilename() != name) {
    console.error('FILENAME MISMATCH');
    process.exit(1);
  }
  if (!got.equals(data)) {
    console.error('MISMATCH');
    process.exit(1);
  }
  console.log('OK: file matches');
})().catch(e => { console.error(e); process.exit(1); });
