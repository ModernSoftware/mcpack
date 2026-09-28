"""Model-free integration test; writes synthetic claims/refunds to the sample."""

import os
import uuid

from main import create_client
from refund_workflow import RefundWorkflow, decode_result


def main():
    client = create_client(
        os.environ.get("MCP_URL", "http://localhost:3000/mcp"),
        os.environ["MCPACK_HTTP_TOKEN"],
    )
    calls = []

    def call(name, arguments):
        calls.append(name)
        return client.call_tool_sync(str(uuid.uuid4()), name, arguments)

    with client:
        claim = decode_result(
            call(
                "open_claim",
                {
                    "order_id": "ORD-10482",
                    "reason": "damaged",
                    "request_key": f"approval-{uuid.uuid4()}",
                },
            )
        )["claim"]
        key = f"approval-{uuid.uuid4()}"
        denied = RefundWorkflow(call, lambda _: False)
        assert (
            denied.approve("ORD-10482", claim["id"], key)["outcome"]
            == "denied_by_operator"
        )
        assert "submit_refund" not in calls
        print(
            "PASS: real invoice/policy retrieval; denied approval produces no refund call"
        )

        snapshots = []

        def confirm(snapshot):
            snapshots.append(snapshot)
            return True

        approved = RefundWorkflow(call, confirm)
        result = approved.approve("ORD-10482", claim["id"], key)
        assert result["outcome"] == "processed", result
        assert snapshots[0]["amount_cents"] == 1482
        assert {d["kind"] for d in snapshots[0]["evidence"]} == {"invoice", "policy"}
        assert approved.approve("ORD-10482", claim["id"], key)["outcome"] == "processed"
        assert calls.count("submit_refund") == 1
        print("PASS: approval submits once; repeat reconciles the same refund")


if __name__ == "__main__":
    main()
