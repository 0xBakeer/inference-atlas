/**
 * The Python that runs inside the engine's own environment.
 *
 * These snippets are the whole of DESIGN §3.4: instead of maintaining a flag list by hand
 * per engine per version, ask the build itself. They are executed with `python3 -c` either
 * inside the engine's container (`--method docker`) or in the current environment
 * (`--method pip`), print one JSON object on stdout and nothing else, and never import
 * anything that needs a GPU — building an argparse parser touches no CUDA, which is why
 * `ingest-engines.yml` can run nightly on a plain `ubuntu-latest` runner.
 *
 * `_actions` is private argparse API; see the note in `argparse.ts` for why that is the
 * right trade here.
 */

/** Shared tail: serialize `parser._actions` in the shape `paramsFromArgparse` expects. */
const DUMP = `
import json, sys

def _default(value):
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (list, tuple)):
        return [_default(v) for v in value]
    if isinstance(value, dict):
        return {str(k): _default(v) for k, v in value.items()}
    try:
        json.dumps(value)
        return value
    except Exception:
        return None

def dump(parser, engine_id, version, source):
    actions = []
    for action in parser._actions:
        type_name = getattr(action.type, "__name__", None)
        if type_name is None and action.type is not None:
            type_name = type(action.type).__name__
        choices = None
        if action.choices is not None:
            try:
                choices = [c if isinstance(c, (str, int, float, bool)) else str(c) for c in action.choices]
            except TypeError:
                choices = None
        actions.append({
            "option_strings": list(action.option_strings),
            "dest": action.dest,
            "type": type_name,
            "default": _default(action.default),
            "choices": choices,
            "help": action.help,
            "nargs": action.nargs,
            "class": type(action).__name__,
            "metavar": action.metavar if isinstance(action.metavar, str) else None,
        })
    json.dump({"engine_id": engine_id, "version": version, "source": source, "actions": actions},
              sys.stdout)
`;

export const VLLM_SNIPPET = `${DUMP}
import vllm
from vllm.engine.arg_utils import EngineArgs
try:
    from vllm.utils import FlexibleArgumentParser
except ImportError:
    from vllm.utils.argparse_utils import FlexibleArgumentParser

parser = FlexibleArgumentParser(description="atlas-ingest")
EngineArgs.add_cli_args(parser)
dump(parser, "vllm", vllm.__version__, "vllm.engine.arg_utils.EngineArgs.add_cli_args")
`;

export const SGLANG_SNIPPET = `${DUMP}
import argparse
import sglang
from sglang.srt.server_args import ServerArgs

parser = argparse.ArgumentParser(description="atlas-ingest")
ServerArgs.add_cli_args(parser)
dump(parser, "sglang", getattr(sglang, "__version__", ""), "sglang.srt.server_args.ServerArgs.add_cli_args")
`;

export const SNIPPETS: Record<string, string> = {
  vllm: VLLM_SNIPPET,
  sglang: SGLANG_SNIPPET,
};

/** `--help` invocations for the engines that have no Python parser to introspect. */
export const HELP_COMMANDS: Record<string, string[]> = {
  llamacpp: ['llama-server', '--help'],
  ollama: ['ollama', 'serve', '--help'],
  'mlx-lm': ['python3', '-m', 'mlx_lm.server', '--help'],
};
