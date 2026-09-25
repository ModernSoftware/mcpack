"""Native handlers: no FastMCP or MCP SDK dependency is needed in the worker."""

import os


def create_worker(context):
    calls = 0
    print("Python worker ready")  # Routed to diagnostics, never MCP stdout.

    def summarize(args, call):
        nonlocal calls
        call.signal.throw_if_aborted()
        calls += 1
        values = args["values"]
        total = sum(values)
        return {
            "content": [{"type": "text", "text": f"Total: {total}; count: {len(values)}"}],
            "structuredContent": {
                "total": total, "count": len(values), "calls": calls,
                "pid": os.getpid(), "runtime": "python",
            },
        }

    async def guide(args, call):
        return {"contents": [{
            "uri": args["uri"], "mimeType": "text/plain",
            "text": "Call greet in Node and summarize in Python, then request review.",
        }]}

    def review(args, call):
        return {"messages": [{
            "role": "user",
            "content": {"type": "text", "text": f"Review these results: {args['summary']}"},
        }]}

    def close():
        context.log("Python worker closed")

    return {
        "tools": {"summarize": summarize},
        "resources": {"guide": guide},
        "prompts": {"review": review},
        "close": close,
    }
