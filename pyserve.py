#!/usr/bin/env python3
"""Static file server that honours Range — what http.server would be if it did.

    python3 map-viz/pyserve.py [root] [port]

`python3 -m http.server` ignores the Range header and answers 200 with the whole
file. A reader that trusts that reads from offset 0 and gets the wrong bytes, so
this exists rather than a warning in a README.
"""
import os, sys, re
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class RangeHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Expose-Headers', 'Content-Range, Content-Length')
        super().end_headers()

    def send_head(self):
        rng = self.headers.get('Range')
        if not rng:
            return super().send_head()
        m = re.fullmatch(r'bytes=(\d*)-(\d*)', rng.strip())
        path = self.translate_path(self.path)
        if not m or not os.path.isfile(path):
            return super().send_head()

        size = os.path.getsize(path)
        first, last = m.group(1), m.group(2)
        if first == '':                                   # suffix range: last N bytes
            start, end = max(0, size - int(last or 0)), size - 1
        else:
            start = int(first)
            end = int(last) if last else size - 1
        end = min(end, size - 1)
        if start > end or start >= size:
            self.send_response(416)
            self.send_header('Content-Range', f'bytes */{size}')
            self.end_headers()
            return None

        f = open(path, 'rb')
        f.seek(start)
        self.send_response(206)
        self.send_header('Content-Type', self.guess_type(path))
        self.send_header('Content-Length', str(end - start + 1))
        self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        self.end_headers()
        # copyfile() would send to EOF, so hand back only the slice asked for.
        return _Slice(f, end - start + 1)


class _Slice:
    """File-like wrapper that stops after n bytes, for copyfile()."""
    def __init__(self, f, n): self.f, self.left = f, n
    def read(self, size=-1):
        if self.left <= 0: return b''
        if size is None or size < 0: size = self.left
        data = self.f.read(min(size, self.left))
        self.left -= len(data)
        return data
    def close(self): self.f.close()


if __name__ == '__main__':
    root = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 8300
    os.chdir(root)
    print(f'http://localhost:{port}  <- {root}  (Range: bytes)')
    ThreadingHTTPServer(('', port), partial(RangeHandler, directory=root)).serve_forever()
