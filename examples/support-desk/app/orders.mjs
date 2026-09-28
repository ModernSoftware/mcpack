import { randomUUID } from 'node:crypto';
import { database, result, failure } from './db.mjs';

export function createWorker() {
  const db = database();

  return {
    tools: {
      find_orders: async ({ customer_id, after = '', limit = 20 }) => {
        const { rows } = await db.query(
          'SELECT * FROM desk.orders WHERE customer_id=$1 AND id>$2 ORDER BY id LIMIT $3',
          [customer_id, after, limit],
        );
        return result({ orders: rows, next_cursor: rows.length === limit ? rows.at(-1).id : null });
      },
      get_customer_summary: async ({ customer_id }) => {
        const { rows } = await db.query('SELECT id,name FROM desk.customers WHERE id=$1', [
          customer_id,
        ]);
        return rows.length ? result({ customer: rows[0] }) : failure('Customer not found');
      },
      get_order_details: async ({ order_id }) => {
        const order = await db.query('SELECT * FROM desk.orders WHERE id=$1', [order_id]);
        if (!order.rowCount) return failure('Order not found');
        const [items, shipments, claims] = await Promise.all([
          db.query('SELECT * FROM desk.order_items WHERE order_id=$1', [order_id]),
          db.query('SELECT * FROM desk.shipment_events WHERE order_id=$1 ORDER BY occurred_at', [
            order_id,
          ]),
          db.query(
            'SELECT c.*,r.explanation FROM desk.claims c LEFT JOIN desk.rejection_reasons r ON r.code=c.rejection_code WHERE order_id=$1 ORDER BY id LIMIT 50',
            [order_id],
          ),
        ]);
        return result({
          order: order.rows[0],
          items: items.rows,
          shipments: shipments.rows,
          claims: claims.rows,
        });
      },
      open_claim: async ({ order_id, reason, request_key }) => {
        const order = await db.query('SELECT 1 FROM desk.orders WHERE id=$1', [order_id]);
        if (!order.rowCount) return failure('Order not found');
        const id = `CLM-${randomUUID()}`;
        await db.query(
          `INSERT INTO desk.claims(id,order_id,reason,status,request_key) VALUES($1,$2,$3,'open',$4) ON CONFLICT(request_key) DO NOTHING`,
          [id, order_id, reason, request_key],
        );
        const { rows } = await db.query('SELECT * FROM desk.claims WHERE request_key=$1', [
          request_key,
        ]);
        if (rows[0].order_id !== order_id || rows[0].reason !== reason)
          return failure('Idempotency key conflicts with a different claim');
        return result({ claim: rows[0] });
      },
    },
    close: () => db.end(),
  };
}
