/**
 * Which engines can run on which device.
 *
 * The gap ranking crosses every model × quant × hardware × engine, and without this filter
 * the wanted queue would be dominated by cells that are not physically possible: vLLM on an
 * M2 Max, MLX on an RTX 4090, TensorRT-LLM on a Radeon. Nothing new is invented here — the
 * engine already declares `platforms` and the device already declares `vendor` and `kind`;
 * this is only the mapping between those two vocabularies, in one place, so that adding an
 * engine or a device stays a pull request that adds a JSON file (SPEC §0.4).
 *
 * The mapping (documented in `tools/README.md`):
 *
 * | device vendor / kind | platforms it can host |
 * |---|---|
 * | `nvidia`, gpu or soc  | `linux-cuda`, `windows-cuda` |
 * | `amd`, gpu            | `linux-rocm` |
 * | `apple`, soc          | `macos-metal`, `macos-cpu` |
 * | `intel`, gpu          | `linux-xpu` |
 * | any vendor, kind `cpu`| `linux-cpu`, `windows-cpu` (plus `macos-cpu` on Apple) |
 *
 * An engine fits a device when the two sets intersect. Unknown vendors fall back to the
 * CPU platforms, which is the honest answer for a device nobody has classified yet.
 */
import type { EngineMeta, Hardware, Platform } from '@atlas/core';

const CPU_PLATFORMS: Platform[] = ['linux-cpu', 'windows-cpu'];

export function hardwarePlatforms(hardware: Hardware): Platform[] {
  const vendor = hardware.vendor.toLowerCase();
  const kind = hardware.kind;

  if (kind === 'cpu') {
    return vendor === 'apple' ? ['macos-cpu', ...CPU_PLATFORMS] : [...CPU_PLATFORMS];
  }
  switch (vendor) {
    case 'nvidia':
      return ['linux-cuda', 'windows-cuda'];
    case 'amd':
      return ['linux-rocm'];
    case 'apple':
      return ['macos-metal', 'macos-cpu'];
    case 'intel':
      return ['linux-xpu'];
    default:
      return [...CPU_PLATFORMS];
  }
}

export function engineFitsHardware(engine: EngineMeta, hardware: Hardware): boolean {
  const hosted = new Set<string>(hardwarePlatforms(hardware));
  return engine.platforms.some((platform) => hosted.has(platform));
}
