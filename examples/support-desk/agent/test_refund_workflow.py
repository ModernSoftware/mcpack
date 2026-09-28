import copy
import unittest
from concurrent.futures import ThreadPoolExecutor

from refund_workflow import RefundWorkflow, decode_result


class FakeService:
    def __init__(self):
        self.calls = []
        self.fail = None
        self.lost_response = False
        self.unknown = False
        self.amount = 1482
        self.missing_invoice = False
        self.claim_order = "ORD-10482"
        self.refund = None

    def call(self, name, args):
        self.calls.append((name, args))
        if name == self.fail:
            raise TimeoutError("synthetic failure")
        if name == "get_order_details":
            value = {
                "order": {"id": "ORD-10482", "total_cents": 1482},
                "claims": [
                    {
                        "id": "CLM-1",
                        "order_id": self.claim_order,
                        "status": "open",
                        "reason": "damaged",
                    }
                ],
            }
        elif name == "find_documents":
            value = {"documents": [{"id": "POLICY-REFUND", "kind": "policy"}]}
            if not self.missing_invoice:
                value["documents"].append({"id": "INV-10482", "kind": "invoice"})
        elif name == "read_document":
            value = {"text": "Synthetic evidence for " + args["document_id"]}
        elif name == "evaluate_refund_eligibility":
            value = {
                "eligible": True,
                "amount_cents": self.amount,
                "policy_version": "v1",
            }
        elif name == "submit_refund":
            self.refund = {
                "id": "REF-1",
                "claim_id": args["claim_id"],
                "idempotency_key": args["idempotency_key"],
                "amount_cents": 1482,
                "status": "processed",
            }
            if self.lost_response:
                raise TimeoutError("committed, response lost")
            value = {"refund": self.refund}
        elif name == "get_refund_status":
            if self.unknown or not self.refund:
                return {"status": "error", "content": [{"text": "Unavailable"}]}
            value = {"refund": self.refund}
        else:
            raise AssertionError(name)
        return {"structuredContent": copy.deepcopy(value)}


class ApprovalTests(unittest.TestCase):
    def setUp(self):
        self.service = FakeService()
        self.snapshots = []
        self.approved = True
        self.workflow = RefundWorkflow(self.service.call, self.confirm)

    def confirm(self, snapshot):
        self.snapshots.append(copy.deepcopy(snapshot))
        return self.approved

    def approve(self, key="stable-key"):
        return self.workflow.approve("ORD-10482", "CLM-1", key)

    def submits(self):
        return sum(name == "submit_refund" for name, _ in self.service.calls)

    def test_investigation_precedes_approval_and_write(self):
        self.assertEqual(self.approve()["outcome"], "processed")
        names = [name for name, _ in self.service.calls]
        self.assertEqual(
            names,
            [
                "get_order_details",
                "find_documents",
                "read_document",
                "read_document",
                "evaluate_refund_eligibility",
                "submit_refund",
            ],
        )
        self.assertEqual(self.snapshots[0]["amount_cents"], 1482)
        self.assertEqual(
            {d["kind"] for d in self.snapshots[0]["evidence"]}, {"invoice", "policy"}
        )

    def test_missing_invoice_blocks_without_prompt_or_write(self):
        self.service.missing_invoice = True
        self.assertEqual(self.approve()["outcome"], "blocked")
        self.assertEqual(self.snapshots, [])
        self.assertEqual(self.submits(), 0)

    def test_failed_read_blocks_without_prompt_or_write(self):
        self.service.fail = "read_document"
        self.assertEqual(self.approve()["outcome"], "blocked")
        self.assertEqual(self.snapshots, [])
        self.assertEqual(self.submits(), 0)

    def test_mismatched_claim_blocks(self):
        self.service.claim_order = "ORD-OTHER"
        self.assertEqual(self.approve()["outcome"], "blocked")
        self.assertEqual(self.submits(), 0)

    def test_mismatched_amount_blocks(self):
        self.service.amount = 9999
        self.assertEqual(self.approve()["outcome"], "blocked")
        self.assertEqual(self.snapshots, [])

    def test_denied_approval_never_submits(self):
        self.approved = False
        self.assertEqual(self.approve()["outcome"], "denied_by_operator")
        self.assertEqual(self.submits(), 0)

    def test_terminal_closed_never_submits(self):
        def closed(_):
            raise EOFError()

        self.workflow.confirm = closed
        self.assertEqual(self.approve()["outcome"], "denied_by_operator")
        self.assertEqual(self.submits(), 0)

    def test_lost_response_reconciles_without_replay(self):
        self.service.lost_response = True
        self.assertEqual(self.approve()["outcome"], "processed")
        self.assertEqual(self.submits(), 1)
        self.assertEqual(
            self.service.calls[-1],
            ("get_refund_status", {"idempotency_key": "stable-key"}),
        )

    def test_unknown_outcome_retains_key_and_never_replays(self):
        self.service.lost_response = True
        self.service.unknown = True
        self.assertEqual(self.approve()["outcome"], "unknown")
        self.assertEqual(self.approve()["outcome"], "unknown")
        self.assertEqual(self.approve("replacement-key")["outcome"], "blocked")
        self.assertEqual(self.submits(), 1)
        self.assertEqual(len(self.snapshots), 1)

    def test_wrong_reconciliation_cannot_report_success(self):
        self.service.lost_response = True
        self.service.unknown = True
        self.approve()
        self.service.unknown = False
        self.service.refund["claim_id"] = "CLM-OTHER"
        self.assertEqual(self.approve()["outcome"], "unknown")
        self.assertEqual(self.submits(), 1)

    def test_concurrent_approvals_submit_once(self):
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.approve(), range(4)))
        self.assertTrue(all(r["outcome"] == "processed" for r in results))
        self.assertEqual(self.submits(), 1)
        self.assertEqual(len(self.snapshots), 1)

    def test_strands_text_result_and_error_handling(self):
        self.assertEqual(
            decode_result({"status": "success", "content": [{"text": '{"ok":true}'}]}),
            {"ok": True},
        )
        from refund_workflow import EvidenceError

        with self.assertRaises(EvidenceError):
            decode_result({"status": "error", "structuredContent": {"ok": True}})


if __name__ == "__main__":
    unittest.main(verbosity=2)
