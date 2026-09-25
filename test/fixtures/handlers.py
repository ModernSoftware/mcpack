import asyncio
import json
import os
from pathlib import Path
import time
import sys


def create_worker(context):
    count = 0

    async def probe(args, call):
        nonlocal count
        action = args.get("action", "count")
        if action == "hang":
            await asyncio.Future()
        if action == "crash":
            os._exit(7)
        if action == "throw":
            raise RuntimeError("PRIVATE_EXCEPTION")
        if action == "invalid":
            return {"content": "wrong"}
        if action == "bigint":
            return {"content": [], "structuredContent": {"value": {1, 2}}}
        if action == "large_integer":
            return {"content": [], "structuredContent": {"value": 2**60}}
        if action == "interpreter":
            return {"content": [], "structuredContent": {"prefix": sys.prefix}}
        if action == "nan":
            return {"content": [], "structuredContent": {"value": float("nan")}}
        if action == "business":
            return {"content": [{"type": "text", "text": "Denied by business rule"}], "isError": True}
        if action == "env":
            values = {key: os.environ[name] for key, name in {
                "inherited": "MCPACK_TEST_INHERITED",
                "hidden": "MCPACK_TEST_HIDDEN",
                "explicit": "MCPACK_TEST_EXPLICIT",
            }.items() if name in os.environ}
            return {"content": [{"type": "text", "text": json.dumps(values)}]}
        if action == "malformed":
            os.write(1, b"not-json\n")
            await asyncio.Future()
        print("This must not reach MCP stdout")
        await asyncio.sleep(args.get("delay", 0) / 1000)
        count += 1
        return {"content": [{"type": "text", "text": str(count)}],
                "structuredContent": {"count": count, "pid": os.getpid(), "worker": context.worker_id}}

    def sync_probe(args, call):
        call.signal.throw_if_aborted()
        if args.get("action") == "hang":
            while True:
                time.sleep(1)
        return {"content": [{"type": "text", "text": "synchronous"}]}

    async def close():
        if context.config.get("hangOnClose"):
            await asyncio.Future()
        if context.config.get("marker"):
            Path(context.config["marker"]).write_text("closed", encoding="utf-8")

    return {"tools": {"probe": probe, "sync_probe": sync_probe}, "close": close}


async def async_factory(context):
    await asyncio.sleep(0)
    return create_worker(context)


async def neverReady(context):
    await asyncio.Future()
