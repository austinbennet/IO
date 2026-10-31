#!/usr/bin/env python3
"""Simulated live origin for IO failover tests.

Serves an FFmpeg-generated MPEG-TS file (tests/media/sample-origin.ts) over HTTP in real time,
looping forever. Stopping this process simulates a primary-source outage.

Usage: python3 tests/media_origin.py [port]
"""
import http.server
import os
import socketserver
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'media', 'sample-origin.ts')
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9000
BITRATE_BPS = 6_900_000  # matches sample-origin.ts (~6.9 Mbps)


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.0'

    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'video/mp2t')
        self.end_headers()
        chunk = 188 * 64
        try:
            while True:
                with open(SRC, 'rb') as f:
                    while True:
                        data = f.read(chunk)
                        if not data:
                            break
                        self.wfile.write(data)
                        time.sleep(len(data) * 8 / BITRATE_BPS)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, *args):
        pass


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == '__main__':
    Server(('127.0.0.1', PORT), Handler).serve_forever()
