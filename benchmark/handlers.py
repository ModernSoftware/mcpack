import asyncio
import os


def create_worker(context):
    async def probe(args, call):
        if args.get("delayMs"):
            await asyncio.sleep(args["delayMs"] / 1000)
        checksum = 0
        for i in range(args.get("iterations", 0)):
            checksum = (checksum + i) % 65521
        return {
            "content": [{"type": "text", "text": args.get("payload", "")}],
            "structuredContent": {"checksum": checksum, "pid": os.getpid()},
        }

    return {"tools": {"probe": probe}}
