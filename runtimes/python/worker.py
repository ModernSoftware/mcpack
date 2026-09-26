"""MCPack's private persistent Python runner (Python 3.11+, standard library only)."""

import asyncio
import importlib.util
import inspect
import json
from pathlib import Path
import sys
import threading
import traceback
from types import SimpleNamespace

# Reserve the original binary streams before importing any application code.
_protocol_out = sys.stdout.buffer
_protocol_in = sys.stdin.buffer
sys.stderr.reconfigure(encoding="utf-8", errors="backslashreplace")
sys.stdout = sys.stderr
_max_output_bytes = 1024 * 1024


def send(message):
    frame = json.dumps({"v": 1, **message}, allow_nan=False, ensure_ascii=False,
                       separators=(",", ":")).encode("utf-8", errors="backslashreplace")
    if len(frame) > _max_output_bytes:
        payload = {"v": 1, "type": "error", "code": "OUTPUT_LIMIT_EXCEEDED",
                   "message": "Worker response exceeded maxOutputBytes."}
        if "id" in message:
            payload["id"] = message["id"]
        frame = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    _protocol_out.write(frame + b"\n")
    _protocol_out.flush()


def report(code, message, request_id=None):
    payload = {"type": "error", "code": code, "message": message}
    if request_id is not None:
        payload["id"] = request_id
    send(payload)


class AbortSignal:
    def __init__(self):
        self._event = threading.Event()

    @property
    def aborted(self):
        return self._event.is_set()

    def throw_if_aborted(self):
        if self.aborted:
            raise RuntimeError("Request cancelled")

    def abort(self):
        self._event.set()


async def invoke(function, *args):
    # Sync functions use a thread so the control loop can still process close/cancel.
    if inspect.iscoroutinefunction(function):
        return await function(*args)
    result = await asyncio.to_thread(function, *args)
    return await result if inspect.isawaitable(result) else result


def load_factory(message):
    path = Path(message["module"])
    sys.path[:0] = [str(path.parent), message["projectRoot"]]
    spec = importlib.util.spec_from_file_location("_mcpack_handlers", path)
    if spec is None or spec.loader is None:
        raise ValueError("Cannot load Python module")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    factory = getattr(module, message["exportName"])
    if not callable(factory):
        raise TypeError("Factory must be callable")
    return factory


class Runner:
    def __init__(self):
        self.worker = None
        self.context = None
        self.active = None
        self.signal = None
        self.request_id = None

    async def initialize(self, message):
        global _max_output_bytes
        _max_output_bytes = message["maxOutputBytes"]
        self.context = SimpleNamespace(
            worker_id=message["workerId"],
            project_root=message["projectRoot"],
            config=message["config"],
            log=lambda value: print(value, file=sys.stderr, flush=True),
        )
        factory = await asyncio.to_thread(load_factory, message)
        self.worker = await invoke(factory, self.context)
        if not isinstance(self.worker, dict):
            raise TypeError("Factory must return a dictionary")
        for binding in message["bindings"]:
            table = self.worker.get(binding["kind"], {})
            if not isinstance(table, dict) or not callable(table.get(binding["handler"])):
                raise ValueError(f"Missing handler: {binding}")
        if "close" in self.worker and not callable(self.worker["close"]):
            raise TypeError("close must be callable")
        send({"type": "ready"})

    async def call(self, message, signal):
        context = SimpleNamespace(
            **vars(self.context), request_id=message["id"], signal=signal
        )
        try:
            handler = self.worker[message["kind"]][message["handler"]]
            try:
                result = await invoke(handler, message["input"], context)
            except Exception:
                traceback.print_exc(file=sys.stderr)
                report("HANDLER_FAILED", "Handler failed; inspect worker diagnostics.", message["id"])
                return
            try:
                # The host validates capability-specific result shapes with the same
                # schemas used for Node. This step rejects non-JSON Python values.
                validate_json(result)
                send({"type": "result", "id": message["id"], "result": result})
            except (TypeError, ValueError, OverflowError, RecursionError):
                report("INVALID_RESULT", "Handler returned a non-JSON result.", message["id"])
        finally:
            self.active = None
            self.signal = None
            self.request_id = None

    async def close(self):
        if self.signal:
            self.signal.abort()
        if self.active:
            await self.active
        if self.worker and "close" in self.worker:
            await invoke(self.worker["close"])
        send({"type": "closed"})

    async def run(self):
        while True:
            line = await asyncio.to_thread(_protocol_in.readline)
            if not line:
                await self.close()
                return
            message = json.loads(line)
            if message.get("v") != 1:
                raise ValueError("Unsupported worker protocol version")
            operation = message["type"]
            if operation == "init" and self.worker is None:
                await self.initialize(message)
            elif operation == "call" and self.worker is not None and self.active is None:
                self.signal = AbortSignal()
                self.request_id = message["id"]
                self.active = asyncio.create_task(self.call(message, self.signal))
            elif operation == "cancel":
                if self.request_id == message["id"] and self.signal:
                    self.signal.abort()
            elif operation == "close":
                await self.close()
                return
            else:
                raise ValueError("Unexpected worker message")


def validate_json(value):
    """Reject lossy json.dumps coercions such as tuples and non-string map keys."""
    if type(value) is int and abs(value) > 2**53 - 1:
        raise ValueError("Large integers must be represented as strings")
    if value is None or type(value) in (str, bool, int, float):
        return
    if type(value) is list:
        for item in value:
            validate_json(item)
        return
    if type(value) is dict and all(type(key) is str for key in value):
        for item in value.values():
            validate_json(item)
        return
    raise TypeError("Result must contain only JSON values")


if __name__ == "__main__":
    try:
        if sys.version_info < (3, 11):
            raise RuntimeError("MCPack requires Python 3.11 or newer")
        asyncio.run(Runner().run())
    except Exception:
        traceback.print_exc(file=sys.stderr)
        report("STARTUP_FAILED", "Worker initialization or protocol failed; inspect diagnostics.")
        sys.exit(1)
