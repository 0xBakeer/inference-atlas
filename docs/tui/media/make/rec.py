#!/usr/bin/env python3
"""Drive the real inference-atlas TUI in a pty, on a simulated DGX Spark, and write an asciicast v2.

The app is the built packages/tui/dist/cli.js of this checkout, unmodified. Only the host is
simulated: sim-dgx.mjs reports linux/aarch64 with 20 Cortex-X925 cores, and bin/ puts a fake
lscpu and nvidia-smi ("NVIDIA GB10") first on PATH, so detection lands on nvidia-gb10-dgx-spark
exactly as it would on the box. The data is the live published atlas.
"""
import fcntl, json, os, pty, re, select, struct, sys, tempfile, termios, time
import codecs
import pyte

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..', '..'))
BUILD = os.path.join(HERE, '.build')
# The app prints absolute paths (recipe files, config). It runs with HOME at a short symlink the
# same length as SHOWN_HOME, and the cast rewrites one into the other without moving a column.
HOME = '/tmp/atlhm'
SHOWN_HOME = '/home/user'
assert len(HOME) == len(SHOWN_HOME)
if not os.path.isdir(HOME):
    if os.path.islink(HOME): os.remove(HOME)
    os.symlink(tempfile.mkdtemp(prefix='atlas-tui-rec-'), HOME)
os.makedirs(BUILD, exist_ok=True)
REAL_HOME = os.path.expanduser('~')
PROMPT = '\x1b[1;32muser@spark-dgx\x1b[0m:\x1b[1;34m~\x1b[0m$ '

class Rec:
    def __init__(self, cols=110, rows=32, fresh=False):
        self.cols, self.rows = cols, rows
        self.events, self.vt = [], 0.0
        self.screen = pyte.Screen(cols, rows); self.stream = pyte.ByteStream(self.screen)
        self.fd = None; self.pid = None
        self.dec = codecs.getincrementaldecoder('utf-8')('replace')
        self.carry = ''  # held-back tail that could be the start of HOME
        self.caps = []   # (start, text)
        self.badges = [] # (start, label)
        if fresh:
            os.system(f'rm -rf {HOME}/.config {HOME}/.cache {HOME}/inference-atlas')

    def emit(self, data, dt=0.0):
        self.vt += dt
        if isinstance(data, str): data = data.encode()
        self.stream.feed(data)
        text = self.carry + self.dec.decode(data)
        self.carry = ''
        text = text.replace(HOME, SHOWN_HOME)
        for n in range(len(HOME) - 1, 0, -1):      # never end an event on a partial HOME
            if text.endswith(HOME[:n]):
                self.carry, text = text[-n:], text[:-n]
                break
        if text or not data:
            self.events.append([round(self.vt, 4), 'o', text])

    def shell_type(self, cmd, cps=16, pre=0.6):
        self.emit(PROMPT, 0.3)
        self.vt += pre
        for ch in cmd:
            self.emit(ch, 1.0 / cps)
        self.vt += 0.35
        self.emit('\r\n')

    def spawn(self, args):
        env = dict(os.environ)
        env.update(HOME=HOME, PATH=f'{HERE}/bin:' + env['PATH'], TERM='xterm-256color',
                   COLORTERM='truecolor', NODE_OPTIONS=f'--import={HERE}/sim-dgx.mjs',
                   USER='user', LOGNAME='user')
        for k in ('XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'TERM_PROGRAM', 'NO_COLOR'): env.pop(k, None)
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(HOME)
            os.execvpe('node', ['node', f'{REPO}/packages/tui/dist/cli.js'] + args, env)
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', self.rows, self.cols, 0, 0))
        self.fd, self.pid = fd, pid

    def pump(self, secs, fast=False):
        """Read output for `secs` real seconds. fast: squash the wall time (loading)."""
        end = time.time() + secs; last = time.time()
        while time.time() < end:
            r, _, _ = select.select([self.fd], [], [], 0.02)
            now = time.time()
            if r:
                try: data = os.read(self.fd, 65536)
                except OSError: return False
                if not data: return False
                d = now - last
                self.emit(data, min(d, 0.12) if fast else d); last = now
        if not fast: self.vt += time.time() - last
        return True

    def text(self):
        return '\n'.join(self.screen.display)

    def wait_for(self, pat, timeout=30):
        t0 = time.time()
        while time.time() - t0 < timeout:
            if re.search(pat, self.text()): self.pump(0.25, fast=True); return
            self.pump(0.1, fast=True)
        print(self.text()); raise SystemExit(f'timeout waiting for {pat!r}')

    def cap(self, text):
        self.caps.append((round(self.vt, 3), text))

    def badge(self, label):
        self.badges.append((round(self.vt, 3), label))

    def key(self, k, hold=1.0, fast_settle=0.35, label=None):
        if label is not False:
            names = {'\r': 'enter', '\x1b': 'esc', '\t': 'tab', '\x1b[A': '↑', '\x1b[B': '↓', '\x1b[C': '→', '\x1b[D': '←', ' ': 'space'}
            self.badge(label or names.get(k, k))
        os.write(self.fd, k.encode() if isinstance(k, str) else k)
        self.pump(fast_settle, fast=False)
        self.vt += max(0.0, hold - fast_settle)

    def type(self, s, cps=9, hold=0.8):
        self.badge('type')
        for ch in s: self.key(ch, hold=1.0 / cps, fast_settle=0.05, label=False)
        self.pump(0.3); self.vt += hold

    def hold(self, s): self.vt += s

    def finish(self, then_prompt=True):
        try:
            while True:
                r, _, _ = select.select([self.fd], [], [], 1.0)
                if not r: break
                data = os.read(self.fd, 65536)
                if not data: break
                self.emit(data, 0.02)
        except OSError: pass
        try: os.waitpid(self.pid, 0)
        except ChildProcessError: pass
        if then_prompt:
            self.emit(PROMPT, 0.2); self.vt += 1.5; self.emit('', 0)

    def save(self, name, title):
        path = os.path.join(BUILD, name + '.cast')
        if self.carry:
            self.events.append([round(self.vt, 4), 'o', self.carry]); self.carry = ''
        joined = ''.join(e[2] for e in self.events)
        leaks = [b for b in ('atlhm', '/tmp/', '/private/', REAL_HOME, REPO) if b in joined]
        if leaks: raise SystemExit(f'leak in cast: {leaks}')
        with open(path, 'w') as f:
            f.write(json.dumps({'version': 2, 'width': self.cols, 'height': self.rows,
                                'title': title, 'env': {'TERM': 'xterm-256color', 'SHELL': '/bin/bash'}}) + '\n')
            for e in self.events: f.write(json.dumps(e) + '\n')
        with open(path.replace('.cast', '.meta.json'), 'w') as f:
            json.dump({'duration': self.vt, 'caps': self.caps, 'badges': self.badges,
                       'cols': self.cols, 'rows': self.rows}, f, ensure_ascii=False, indent=1)
        print(f'{path}: {self.vt:.1f}s, {len(self.events)} events')
