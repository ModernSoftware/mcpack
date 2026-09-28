import { result, failure } from './db.mjs';

export function createWorker() {
  const base = process.env.REFUND_API_URL;

  async function request(path, options, signal) {
    const response = await fetch(new URL(path, base), {
      ...options,
      headers: {
        authorization: `Bearer ${process.env.REFUND_API_TOKEN}`,
        'content-type': 'application/json',
      },
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    });

    const value = await response.json();

    return response.ok ? result(value) : failure(value.error ?? 'Refund service rejected request');
  }

  return {
    tools: {
      submit_refund: async ({ claim_id, idempotency_key, confirmed }, context) =>
        confirmed
          ? request(
              '/refunds',
              { method: 'POST', body: JSON.stringify({ claim_id, idempotency_key }) },
              context.signal,
            )
          : failure('Explicit operator confirmation is required'),
      get_refund_status: async ({ idempotency_key }, context) =>
        request(
          `/refunds/${encodeURIComponent(idempotency_key)}`,
          { method: 'GET' },
          context.signal,
        ),
    },
  };
}
