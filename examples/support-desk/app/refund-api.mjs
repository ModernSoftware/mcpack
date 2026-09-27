import { createServer } from 'node:http';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { database } from './db.mjs';
const db = database();
const token = process.env.REFUND_API_TOKEN;
if (!token) throw Error('REFUND_API_TOKEN is required');
const hash = (value) => createHash('sha256').update(value).digest();
const expected = hash(`Bearer ${token}`);
const reply = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const server = createServer({ maxHeaderSize: 8192 }, async (req, res) => {
  try {
    if (req.url === '/healthz' && req.method === 'GET') return reply(res, 200, { status: 'ready' });
    if (!timingSafeEqual(expected, hash(req.headers.authorization ?? '')))
      return reply(res, 401, { error: 'Unauthorized' });
    if (req.method === 'GET' && req.url.startsWith('/refunds/')) {
      const key = decodeURIComponent(req.url.slice('/refunds/'.length));
      const { rows } = await db.query('SELECT * FROM desk.refunds WHERE idempotency_key=$1', [key]);
      return reply(
        res,
        rows.length ? 200 : 404,
        rows.length ? { refund: rows[0] } : { error: 'Refund not found' },
      );
    }
    if (req.method !== 'POST' || req.url !== '/refunds')
      return reply(res, 404, { error: 'Not found' });
    let body = '';
    for await (const chunk of req) {
      body += chunk.toString();
      if (Buffer.byteLength(body) > 4096) return reply(res, 413, { error: 'Body too large' });
    }
    let args;
    try {
      args = JSON.parse(body);
    } catch {
      return reply(res, 400, { error: 'Invalid JSON' });
    }
    if (!args || typeof args !== 'object' || Array.isArray(args))
      return reply(res, 400, { error: 'Invalid request' });
    const { claim_id, idempotency_key } = args;
    if (
      typeof claim_id !== 'string' ||
      typeof idempotency_key !== 'string' ||
      !/^[-a-zA-Z0-9_:]{1,100}$/.test(idempotency_key) ||
      claim_id.length > 100
    )
      return reply(res, 400, { error: 'Invalid request' });
    const fault =
      process.env.SIMULATOR_FAULTS_ENABLED === 'true' ? req.headers['x-simulate'] : undefined;
    if (fault === 'unavailable') return reply(res, 503, { error: 'Simulated service unavailable' });
    const connection = await db.connect();
    let refund;
    try {
      await connection.query('BEGIN');
      // Serialize all submissions for a claim, across processes/replicas.
      const { rows } = await connection.query(
        `SELECT c.*,o.total_cents,o.status AS order_status,
        (d.as_of-o.delivered_at) AS age_days FROM desk.claims c JOIN desk.orders o ON o.id=c.order_id
        CROSS JOIN desk.dataset d WHERE c.id=$1 FOR UPDATE OF c`,
        [claim_id],
      );
      const claim = rows[0];
      if (
        !claim ||
        claim.status === 'rejected' ||
        claim.order_status !== 'delivered' ||
        claim.age_days < 0 ||
        claim.age_days > 30 ||
        !['damaged', 'missing'].includes(claim.reason)
      ) {
        await connection.query('ROLLBACK');
        return reply(res, 422, { error: 'Claim is not eligible' });
      }
      await connection.query(
        `INSERT INTO desk.refunds(id,claim_id,idempotency_key,amount_cents,status)
        VALUES($1,$2,$3,$4,'processed') ON CONFLICT DO NOTHING`,
        [`REF-${randomUUID()}`, claim_id, idempotency_key, claim.total_cents],
      );
      const found = await connection.query('SELECT * FROM desk.refunds WHERE idempotency_key=$1', [
        idempotency_key,
      ]);
      if (!found.rowCount || found.rows[0].claim_id !== claim_id) {
        await connection.query('ROLLBACK');
        return reply(res, 409, { error: 'Refund or idempotency key conflict' });
      }
      refund = found.rows[0];
      await connection.query('COMMIT');
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
    if (fault === 'lost-response') {
      res.destroy();
      return;
    }
    return reply(res, 200, { refund });
  } catch {
    if (!res.destroyed) reply(res, 500, { error: 'Refund service failed' });
  }
});
server.requestTimeout = 10000;
server.headersTimeout = 5000;
server.listen(Number(process.env.PORT ?? 3001), '0.0.0.0');
process.once('SIGTERM', () => {
  server.close(() => void db.end());
  setTimeout(() => server.closeAllConnections(), 5000).unref();
});
