#!/usr/bin/env python3
"""The storyboards. Every scene drives the real TUI; only the host is simulated (see sim-dgx.mjs)."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rec import Rec, HOME
C, R = 132, 57
Q38 = 'qwen3.8 nvfp4-bf16 chat-c32'

def start(fresh=False):
    if not fresh:   # every scene starts from a detected box; the cache stays warm
        try: os.remove(f'{HOME}/.config/inference-atlas/config.toml')
        except FileNotFoundError: pass
    return Rec(C, R, fresh=fresh)

def open_app(r, cap=None, args=()):
    if cap: r.cap(cap)
    r.shell_type('inference-atlas' + ''.join(' ' + a for a in args))
    r.spawn(list(args)); r.wait_for('Worth running')

def quit_app(r):
    r.cap('')
    r.key('q', 0.3); r.finish()

def launch():
    r = start(fresh=True)
    open_app(r, 'On the DGX Spark: one command, no flags')
    r.cap('It probes the box, recognises a DGX Spark (GB10), and syncs the atlas'); r.hold(3.4)
    r.cap('Every measured configuration, ranked by whether it fits this box')
    for _ in range(5): r.key('j', 0.45)
    r.hold(1.4)
    r.cap('s — rank by raw performance instead of fit')
    r.key('s', 2.6); r.key('s', 1.2)
    r.cap('? — every key on one screen')
    r.key('?', 3.4); r.key('\x1b', 0.8)
    quit_app(r)
    r.save('tui-01-launch', 'inference-atlas: first run on a DGX Spark')

def detail():
    r = start()
    open_app(r, 'Open any measurement in full')
    r.cap('/ filters every run — model, quant, engine, workload')
    r.key('/', 0.5); r.type(Q38, cps=12, hold=0.9); r.key('\r', 1.2)
    r.cap('enter opens the run')
    r.key('\r', 0.4); r.wait_for('Gotchas'); r.hold(1.8)
    r.cap('The numbers the run actually carries, and who measured it'); r.hold(3.0)
    r.cap('Fit on this box: the reasoning, not a score — measured peak, % used, decode ceiling'); r.hold(3.6)
    r.cap('TTFT p50…p99 as bars, and every request as one column (tallest = slowest)'); r.hold(3.6)
    r.cap('Gotchas: what somebody had to know to make this run work'); r.hold(3.6)
    r.cap('esc goes back')
    r.key('\x1b', 1.0)
    quit_app(r)
    r.save('tui-02-run-detail', 'inference-atlas: a run in full')

def recipe():
    r = start()
    open_app(r, 'Turn a measured run into an install recipe')
    r.key('/', 0.3); r.type('gemma-4 serve-chat-c32 vllm', cps=16, hold=0.5); r.key('\r', 0.8)
    r.cap('g on a run → a Markdown recipe, written to disk')
    r.key('g', 0.4); r.wait_for('Gotchas'); r.hold(0.6)
    r.key('g', 0.4); r.wait_for('Recipe →'); r.hold(2.6)
    r.cap('The box it is for, why it fits, the pinned weights')
    r.hold(2.0)
    r.cap('Install commands and the exact serve command, every flag explained')
    for _ in range(16): r.key('j', 0.16, fast_settle=0.1)
    r.hold(3.2)
    r.cap('c copies the whole recipe')
    r.key('c', 2.2)
    r.cap('1–9 hand it to a configured agent — claude, opencode, your own')
    r.key('1', 3.4)
    r.key('\x1b', 0.6); r.key('\x1b', 0.6)
    quit_app(r)
    r.save('tui-03-recipe', 'inference-atlas: from run to install recipe')

def runs():
    r = start()
    open_app(r, 'Every measurement in the atlas, filterable')
    r.cap('2 — the runs view: the whole table, unranked')
    r.key('2', 2.4)
    r.cap('/ and a few words — every word must match')
    r.key('/', 0.4); r.type('qwen3.8', cps=10, hold=1.2)
    r.type(' flash', cps=10, hold=1.2)
    r.type(' serve', cps=10, hold=1.0)
    r.key('\r', 0.8)
    for _ in range(3): r.key('j', 0.45)
    r.cap('s — sort by the headline metric, best first')
    r.key('s', 2.8)
    r.cap('backspace widens it again — then try another model')
    r.key('/', 0.3)
    for _ in range(19): r.key('\x7f', 0.07, fast_settle=0.05, label='⌫')
    r.type('ling-3.0', cps=10, hold=0.6); r.key('\r', 2.4)
    quit_app(r)
    r.save('tui-04-runs-filter', 'inference-atlas: filtering the runs')

def pareto():
    r = start()
    open_app(r, 'What are you giving up? The Pareto view')
    r.cap('3 — output tok/s against TTFT p50, frontier drawn bright')
    r.key('3', 3.0)
    r.cap('j/k walk the points; the selected one is named underneath')
    for _ in range(6): r.key('j', 0.7)
    for _ in range(2): r.key('k', 0.7)
    r.hold(1.2)
    r.cap('4 — coverage: which model × hardware squares anyone has measured')
    r.key('4', 3.4)
    r.cap('A blank square is a measurement nobody has made yet'); r.hold(3.0)
    quit_app(r)
    r.save('tui-05-pareto-coverage', 'inference-atlas: pareto and coverage')

def hardware():
    r = start()
    open_app(r, 'Judge everything against the box you deploy to')
    r.cap('b — the hardware picker; the detected box is first')
    r.key('b', 2.6)
    r.cap('Say you deploy to H100s instead…')
    for _ in range(12): r.key('j', 0.18, fast_settle=0.1)
    r.hold(0.8)
    r.cap('+ / - set how many — GPUs in one host pool their memory')
    for _ in range(3): r.key('+', 0.6)
    r.hold(1.0)
    r.cap('enter — every verdict is re-ranked for 4 × H100 80GB')
    r.key('\r', 3.6)
    r.cap('Two Sparks do not pool: a model still has to fit one machine')
    r.key('b', 1.0)
    for _ in range(14): r.key('k', 0.1, fast_settle=0.08)
    r.key('+', 0.9); r.key('\r', 3.8)
    r.cap('Back to the one box on the desk')
    r.key('b', 0.8); r.key('-', 0.6); r.key('\r', 2.2)
    quit_app(r)
    r.save('tui-06-hardware', 'inference-atlas: choosing the target box')

def cli():
    r = start()
    r.cap('It is also a plain CLI')
    r.shell_type('inference-atlas --help'); r.spawn(['--help']); r.pump(1.5, fast=True); r.finish(False)
    r.hold(3.2)
    r.cap('--sync refreshes the cache and exits — cron it, or warm it before a flight')
    r.shell_type('inference-atlas --sync'); r.spawn(['--sync']); r.pump(3, fast=True); r.finish(False)
    r.hold(2.4)
    r.cap('--hardware / --count pick the target box without opening the picker')
    r.shell_type('inference-atlas --hardware nvidia-gb10-dgx-spark --count 1')
    r.spawn(['--hardware', 'nvidia-gb10-dgx-spark', '--count', '1']); r.wait_for('Worth running'); r.hold(2.6)
    quit_app(r)
    r.save('tui-07-cli', 'inference-atlas: the command line')

def tour():
    """The README hero: the whole loop in half a minute."""
    r = start()
    open_app(r, 'inference-atlas on a DGX Spark — what is worth running here?')
    r.cap('Every measured configuration, ranked by fit on the detected box'); r.hold(2.0)
    for _ in range(3): r.key('j', 0.4)
    r.cap('3 — throughput against latency, the frontier drawn bright')
    r.key('3', 2.2)
    for _ in range(3): r.key('j', 0.5)
    r.cap('4 — which model × hardware squares anyone has measured')
    r.key('4', 2.6)
    r.cap('/ filter, enter — one run in full: fit reasoning, latency, gotchas')
    r.key('/', 0.3); r.type('gemma-4 serve-chat-c32 vllm', cps=18, hold=0.4); r.key('\r', 0.5)
    r.key('\r', 0.4); r.wait_for('Gotchas'); r.hold(3.2)
    r.cap('g — an install recipe an agent can follow, written to disk')
    r.key('g', 0.4); r.wait_for('Recipe →'); r.hold(2.0)
    for _ in range(14): r.key('j', 0.12, fast_settle=0.08)
    r.hold(2.4)
    r.key('\x1b', 0.4); r.key('\x1b', 0.4)
    quit_app(r)
    r.save('tui-00-tour', 'inference-atlas: the tour')

ALL = ['launch', 'tour', 'detail', 'recipe', 'runs', 'pareto', 'hardware', 'cli']
if __name__ == '__main__':
    for n in (sys.argv[1:] or ALL): globals()[n]()
