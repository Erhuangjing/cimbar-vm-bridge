#!/usr/bin/env python3
"""把 src/ 下的页面打包成可以直接双击打开的单文件 HTML（WASM 以 base64 内嵌）。

用法：python3 tools/build.py
输出：dist/cimbar-send.html  dist/cimbar-recv.html  dist/index.html
"""
import base64
import datetime
import os
import re
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'src')
VENDOR = os.path.join(ROOT, 'vendor')
DIST = os.path.join(ROOT, 'dist')

PAGES = {
    'send.html': 'cimbar-send.html',
    'recv.html': 'cimbar-recv.html',
}

SCRIPT_RE = re.compile(r'<script([^>]*?)\s+src="([^"]+)"([^>]*)>\s*</script>')


def find(name):
    for d in (SRC, VENDOR):
        path = os.path.join(d, name)
        if os.path.exists(path):
            return path
    raise FileNotFoundError(name)


def read_text(name):
    with open(find(name), 'rt', encoding='utf-8') as f:
        return f.read()


def safe_inline(js, name):
    # 内联到 <script> 里时，"</script" 会提前结束标签
    if re.search(r'</script', js, re.IGNORECASE):
        raise ValueError(name + ' contains </script, cannot inline safely')
    return js


def inline(name):
    if name.endswith('.wasm'):
        with open(find(name), 'rb') as f:
            return base64.b64encode(f.read()).decode('ascii')
    js = read_text(name)
    if name.endswith('-worker.js'):
        # worker 运行在 blob: 里，无法 importScripts 相对路径，直接把胶水代码拼进来
        glue = read_text('cimbar_js.js')
        js = js.replace("importScripts('cimbar_js.js');", glue)
    return safe_inline(js, name)


def build_page(src_name, out_name, version):
    html = read_text(src_name)

    def repl(m):
        attrs = (m.group(1) + m.group(3)).strip()
        if attrs:
            attrs = ' ' + attrs
        return '<script' + attrs + '>\n' + inline(m.group(2)) + '\n</script>'

    html = SCRIPT_RE.sub(repl, html)
    html = html.replace('%VERSION%', version)
    out = os.path.join(DIST, out_name)
    with open(out, 'wt', encoding='utf-8', newline='\n') as f:
        f.write(html)
    print('%s -> %s (%.1f MB)' % (src_name, out, os.path.getsize(out) / 1024 / 1024))


def main():
    os.makedirs(DIST, exist_ok=True)
    with open(os.path.join(VENDOR, 'VERSION'), 'rt') as f:
        upstream = f.read().strip()
    epoch = int(os.environ.get('SOURCE_DATE_EPOCH', '0')) or None
    date = datetime.datetime.fromtimestamp(epoch, datetime.timezone.utc) if epoch else datetime.datetime.now(datetime.timezone.utc)
    version = 'cimbar-vm-bridge %s (libcimbar %s)' % (date.strftime('%Y-%m-%d'), upstream)
    for src_name, out_name in PAGES.items():
        build_page(src_name, out_name, version)
    for name in ('index.html', 'favicon.ico'):
        shutil.copyfile(os.path.join(SRC, name), os.path.join(DIST, name))


if __name__ == '__main__':
    main()
