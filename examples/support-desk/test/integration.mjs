import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
const url = process.env.MCP_URL ?? 'http://localhost:3000/mcp';
const token = process.env.MCPACK_HTTP_TOKEN ?? 'local-mcp-only';
const client = new Client({ name: 'support-desk-test', version: '1' });
const run = randomUUID();
const call = async (name, args) => {
  const response = await client.callTool({ name, arguments: args });
  assert.ok(!response.isError, JSON.stringify(response));
  return response.structuredContent;
};
try {
  assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 401);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  assert.equal((await client.listTools()).tools.length, 9);
  const order = await call('get_order_details', { order_id: 'ORD-10482' });
  assert.equal(order.order.total_cents, 1482);
  assert.equal(
    order.claims.some((c) => c.rejection_code === 'INSUFFICIENT_EVIDENCE'),
    true,
  );
  const found = await call('find_orders', { customer_id: 'CUST-00482', limit: 2 });
  assert.equal(found.orders.length, 2);
  const next = await call('find_orders', {
    customer_id: 'CUST-00482',
    limit: 2,
    after: found.next_cursor,
  });
  assert.equal(
    found.orders.some((a) => next.orders.some((b) => a.id === b.id)),
    false,
  );
  const docs = await call('find_documents', { order_id: 'ORD-10482' });
  assert.equal(
    docs.documents.some((d) => d.id === 'INV-10482'),
    true,
  );
  assert.match((await call('read_document', { document_id: 'INV-10482' })).text, /1482/);
  assert.equal(
    (await call('evaluate_refund_eligibility', { order_id: 'ORD-10482', reason: 'damaged' }))
      .eligible,
    true,
  );
  assert.equal(
    (await call('evaluate_refund_eligibility', { order_id: 'ORD-10004', reason: 'damaged' }))
      .eligible,
    false,
  );
  assert.match(
    (await client.readResource({ uri: 'support://policy' })).contents[0].text,
    /30 days/,
  );
  assert.match(
    (await client.getPrompt({ name: 'investigate_order', arguments: { order_id: 'ORD-10482' } }))
      .messages[0].content.text,
    /ORD-10482/,
  );
  const args = { order_id: 'ORD-10482', reason: 'damaged', request_key: `claim-${run}` };
  const { claim } = await call('open_claim', args);
  assert.equal((await call('open_claim', args)).claim.id, claim.id);
  const refundArgs = { claim_id: claim.id, idempotency_key: `refund-${run}`, confirmed: true };
  assert.equal(
    (
      await client.callTool({
        name: 'submit_refund',
        arguments: { ...refundArgs, confirmed: false },
      })
    ).isError,
    true,
  );
  const responses = await Promise.all(
    Array.from({ length: 4 }, () => call('submit_refund', refundArgs)),
  );
  assert.equal(new Set(responses.map((r) => r.refund.id)).size, 1);
  assert.equal(
    (await call('get_refund_status', { idempotency_key: refundArgs.idempotency_key })).refund
      .amount_cents,
    1482,
  );
  // Local-only fault interface; skip unless explicitly configured for an authorized simulator.
  if (process.env.REFUND_API_URL) {
    const second = await call('open_claim', { ...args, request_key: `lost-${run}` });
    const payload = { claim_id: second.claim.id, idempotency_key: `lost-${run}` };
    await assert.rejects(
      fetch(`${process.env.REFUND_API_URL}/refunds`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${process.env.REFUND_API_TOKEN}`,
          'content-type': 'application/json',
          'x-simulate': 'lost-response',
        },
        body: JSON.stringify(payload),
      }),
    );
    const recovered = await call('get_refund_status', { idempotency_key: payload.idempotency_key });
    assert.equal(
      (await call('submit_refund', { ...payload, confirmed: true })).refund.id,
      recovered.refund.id,
    );
  }
  const rejected = await client
    .callTool({ name: 'find_orders', arguments: { customer_id: 'CUST-00482', limit: 1000 } })
    .catch(() => null);
  assert.ok(rejected === null || rejected.isError);
  console.log(
    'PASS: order investigation, pagination, S3 documents, policy/prompt, confirmation and durable refund idempotency',
  );
} finally {
  await client.close();
}
