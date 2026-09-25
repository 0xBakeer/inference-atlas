// Recording shim: make the TUI believe it runs on a DGX Spark (Linux, aarch64, GB10).
// Nothing real is touched — the probes it runs are the fake lscpu/nvidia-smi on PATH.
import os from 'node:os';
Object.defineProperty(process, 'platform', { value: 'linux' });
os.totalmem = () => 121.7 * 1024 ** 3;
os.cpus = () =>
  Array.from({ length: 20 }, () => ({
    model: 'Cortex-X925',
    speed: 3900,
    times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
  }));
os.hostname = () => 'spark-dgx';
