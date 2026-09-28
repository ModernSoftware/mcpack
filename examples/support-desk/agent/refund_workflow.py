"""Deterministic, client-side approval workflow for the synthetic support sample."""

import json
import re
import threading


class EvidenceError(Exception):
    """The investigation could not establish the required facts."""


def decode_result(response):
    """Accept native MCP results and Strands' adapted MCP tool results."""
    if response.get("isError") or response.get("status") == "error":
        raise EvidenceError("Tool reported an error")
    value = response.get("structuredContent")
    if isinstance(value, dict):
        return value
    for block in response.get("content", []):
        if block.get("type") == "text" or "text" in block:
            try:
                value = json.loads(block["text"])
            except (ValueError, KeyError):
                continue
            if isinstance(value, dict):
                return value
    raise EvidenceError("Tool did not return a JSON object")


class RefundWorkflow:
    def __init__(self, call, confirm):
        self.call = call
        self.confirm = confirm
        self.lock = threading.Lock()
        # Retain uncertain submissions for this agent session. Durable deduplication
        # remains the refund API's responsibility; no operation is replayed here.
        self.attempts = {}
        self.keys = {}

    def read(self, name, **arguments):
        return decode_result(self.call(name, arguments))

    def investigate(self, order_id, claim_id):
        details = self.read("get_order_details", order_id=order_id)
        order = details["order"]
        if order["id"] != order_id:
            raise EvidenceError("Order mismatch")
        claim = next((c for c in details["claims"] if c["id"] == claim_id), None)
        if not claim or claim["order_id"] != order_id or claim["status"] != "open":
            raise EvidenceError("An open claim belonging to this order is required")
        documents = self.read("find_documents", order_id=order_id)["documents"]
        evidence = []
        for kind in ("invoice", "policy"):
            matches = [d for d in documents if d["kind"] == kind]
            if not matches:
                raise EvidenceError(f"Missing {kind} document")
            for document in matches:
                text = self.read("read_document", document_id=document["id"])["text"]
                if not isinstance(text, str) or not text.strip():
                    raise EvidenceError("Empty document")
                evidence.append({"id": document["id"], "kind": kind, "text": text})
        eligibility = self.read(
            "evaluate_refund_eligibility", order_id=order_id, reason=claim["reason"]
        )
        amount = eligibility["amount_cents"]
        if (
            eligibility["eligible"] is not True
            or type(amount) is not int
            or amount <= 0
        ):
            raise EvidenceError("Order is not eligible")
        if amount != order["total_cents"]:
            raise EvidenceError("Refund amount differs from the order total")
        return {
            "order_id": order_id,
            "claim_id": claim_id,
            "reason": claim["reason"],
            "amount_cents": amount,
            "currency": "USD",
            "policy_version": eligibility["policy_version"],
            "evidence": evidence,
        }

    @staticmethod
    def verified_refund(value, attempt):
        refund = value.get("refund", {})
        return (
            isinstance(refund.get("id"), str)
            and bool(refund["id"])
            and refund.get("claim_id") == attempt["claim_id"]
            and refund.get("idempotency_key") == attempt["idempotency_key"]
            and refund.get("amount_cents") == attempt["amount_cents"]
            and refund.get("status") == "processed"
        )

    def reconcile(self, attempt):
        try:
            value = self.read(
                "get_refund_status", idempotency_key=attempt["idempotency_key"]
            )
            if self.verified_refund(value, attempt):
                return {"outcome": "processed", **value}
        except Exception:
            pass
        # A failed/missing status response is not proof that the write failed.
        return {
            "outcome": "unknown",
            "claim_id": attempt["claim_id"],
            "idempotency_key": attempt["idempotency_key"],
            "message": "Do not resubmit or create a replacement claim/key. Reconcile this key with the operator.",
        }

    def approve(self, order_id, claim_id, idempotency_key):
        with self.lock:
            if any(
                not isinstance(v, str) or not re.fullmatch(r"[-a-zA-Z0-9_:]{1,100}", v)
                for v in (order_id, claim_id, idempotency_key)
            ):
                return {"outcome": "blocked", "message": "Invalid identifier"}
            previous = self.attempts.get(claim_id)
            if previous:
                if (
                    previous["idempotency_key"] != idempotency_key
                    or previous["order_id"] != order_id
                ):
                    return {
                        "outcome": "blocked",
                        "message": "Preserve the original order and idempotency key",
                    }
                return self.reconcile(previous)
            if idempotency_key in self.keys:
                return {
                    "outcome": "blocked",
                    "message": "Key already used for another claim",
                }
            try:
                snapshot = self.investigate(order_id, claim_id)
            except Exception:
                return {
                    "outcome": "blocked",
                    "message": "Required investigation failed; no refund submitted",
                }
            snapshot["idempotency_key"] = idempotency_key
            try:
                approved = self.confirm(snapshot)
            except (EOFError, KeyboardInterrupt):
                approved = False
            if approved is not True:
                return {"outcome": "denied_by_operator"}
            self.attempts[claim_id] = snapshot
            self.keys[idempotency_key] = claim_id
            try:
                value = self.read(
                    "submit_refund",
                    claim_id=claim_id,
                    idempotency_key=idempotency_key,
                    confirmed=True,
                )
                if self.verified_refund(value, snapshot):
                    return {"outcome": "processed", **value}
            except Exception:
                pass
            return self.reconcile(snapshot)
