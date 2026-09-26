import asyncio
import os
import time
from pathlib import Path


def create_worker(context):
    root = Path(context.project_root)

    def start(args, call):
        (root / f"started-{args['id']}").write_text(call.request_id)

    def waiting(args, call):
        return not (root / f"release-{args['id']}").exists() and not (
            call.signal.aborted and args.get("cooperate")
        )

    def finish(args, call):
        (root / f"finished-{args['id']}").write_text("finished")
        if args.get("crash"):
            os._exit(7)
        if args.get("fail"):
            raise RuntimeError("private failure")
        return {"content": [], "structuredContent": {
            "id": args["id"], "requestId": call.request_id
        }}

    async def probe(args, call):
        start(args, call)
        while waiting(args, call):
            await asyncio.sleep(0.005)
        return finish(args, call)

    def sync_probe(args, call):
        start(args, call)
        while waiting(args, call):
            time.sleep(0.005)
        return finish(args, call)

    async def read(args, call):
        await probe({"id": "resource"}, call)
        return {"contents": [{"uri": args["uri"], "text": "resource"}]}

    async def render(args, call):
        await probe({"id": "prompt"}, call)
        return {"messages": [{"role": "user", "content": {
            "type": "text", "text": "prompt"
        }}]}

    def close():
        with (root / f"closed-{context.worker_id}").open("ab") as marker:
            marker.write(b"closed\n")

    return {"tools": {"probe": probe, "sync": sync_probe},
            "resources": {"read": read}, "prompts": {"render": render}, "close": close}
