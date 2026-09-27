import asyncio
import os
from pathlib import Path


def create_worker(context):
    def path(name):
        return Path(context.project_root) / f"{context.worker_id}-{name}"

    # Cross-platform liveness is asserted from the Node host tests. Avoid Python's
    # Windows os.kill(pid, 0), which does not have Unix signal-zero semantics.
    with path("starts").open("ab") as stream:
        stream.write(f"{os.getpid()}\n".encode())
    if path("fail-start").exists():
        raise RuntimeError("PRIVATE_STARTUP_DETAIL")
    if path("hang-start").exists():
        return never_ready()
    count = 0

    async def probe(args, call):
        nonlocal count
        with path("calls").open("ab") as stream:
            stream.write((args.get("id", "call") + "\n").encode())
        while args.get("gate") and not path("release").exists():
            await asyncio.sleep(0.005)
        if args.get("action") == "crash":
            os._exit(7)
        if args.get("action") == "hang":
            await asyncio.Future()
        if args.get("action") == "protocol":
            os.write(1, b"garbage\n")
            await asyncio.Future()
        if args.get("action") == "throw":
            raise RuntimeError("PRIVATE_HANDLER_DETAIL")
        count += 1
        return {"content": [], "structuredContent": {"pid": os.getpid(), "count": count}}

    return {"tools": {"probe": probe}}


async def never_ready():
    await asyncio.Future()
