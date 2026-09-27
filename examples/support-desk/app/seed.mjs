import { readFile } from 'node:fs/promises';
import {
  S3Client,
  CreateBucketCommand,
  PutObjectCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';
import { database } from './db.mjs';
const pool = database();
const s3 = new S3Client({
  region: process.env.AWS_REGION ?? 'us-east-1',
  endpoint: process.env.S3_ENDPOINT || undefined,
  forcePathStyle: Boolean(process.env.S3_ENDPOINT),
});
const bucket = process.env.DOCUMENT_BUCKET;
try {
  await pool.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
  // Reruns preserve claims/refunds; resetting requires explicitly destroying the dataset.
  await pool.query(`INSERT INTO desk.dataset VALUES (1,'2026-01-31') ON CONFLICT DO NOTHING;
    INSERT INTO desk.customers SELECT 'CUST-'||lpad(n::text,5,'0'), 'Synthetic Customer '||n, 'customer'||n||'@example.invalid' FROM generate_series(1,2000)n ON CONFLICT DO NOTHING;
    INSERT INTO desk.orders SELECT 'ORD-'||(10000+n), 'CUST-'||lpad((((n-1)%2000)+1)::text,5,'0'),
      CASE WHEN n%4=0 THEN 'cancelled' ELSE 'delivered' END, 1000+n%9000, DATE '2026-01-31'-(n%60)
      FROM generate_series(1,10000)n ON CONFLICT DO NOTHING;
    INSERT INTO desk.order_items SELECT id,'SKU-DEMO',1 FROM desk.orders ON CONFLICT DO NOTHING;
    INSERT INTO desk.shipment_events SELECT id,'dispatched',delivered_at-2 FROM desk.orders ON CONFLICT DO NOTHING;
    INSERT INTO desk.rejection_reasons VALUES ('OUTSIDE_WINDOW','Delivery is outside the 30-day window'), ('INSUFFICIENT_EVIDENCE','Please provide evidence of damage') ON CONFLICT DO NOTHING;
    INSERT INTO desk.claims VALUES ('CLM-HISTORIC','ORD-10482','damaged','rejected','INSUFFICIENT_EVIDENCE','seed-historic') ON CONFLICT DO NOTHING;`);
  const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
  for (const [role, password] of [
    ['desk_app', process.env.APP_DB_PASSWORD],
    ['refund_app', process.env.REFUND_DB_PASSWORD],
  ]) {
    if (!password) throw Error('Application database passwords must be supplied');
    const exists = await pool.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role]);
    if (!exists.rowCount) await pool.query(`CREATE ROLE ${role} LOGIN PASSWORD ${quote(password)}`);
    await pool.query(`GRANT USAGE ON SCHEMA desk TO ${role}`);
  }
  await pool.query(`GRANT SELECT ON ALL TABLES IN SCHEMA desk TO desk_app;
    GRANT INSERT ON desk.claims TO desk_app;
    GRANT SELECT ON desk.claims,desk.orders,desk.dataset,desk.refunds TO refund_app;
    GRANT INSERT ON desk.refunds TO refund_app;
    GRANT UPDATE ON desk.claims TO refund_app;`);
  // Cloud bucket is provisioned by Terraform; only the local emulator may create one.
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (error) {
    if (!process.env.S3_ENDPOINT) throw error;
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  }
  const invoices = [...Array.from({ length: 100 }, (_, i) => i + 1), 482];
  const documents = invoices.map((n) => ({
    id: `INV-${10000 + n}`,
    order: `ORD-${10000 + n}`,
    kind: 'invoice',
    key: `invoices/ORD-${10000 + n}.txt`,
    title: `Invoice ORD-${10000 + n}`,
    text: `SYNTHETIC INVOICE\nOrder: ORD-${10000 + n}\nAmount: ${1000 + (n % 9000)} USD cents\nNo real customer or payment information.\n`,
  }));
  documents.push({
    id: 'POLICY-REFUND',
    order: null,
    kind: 'policy',
    key: 'policies/refunds.md',
    title: 'Refund policy v1',
    text: '# Refund policy v1\nDamaged or missing delivered orders within 30 days qualify for a full refund. Cancelled orders and change-of-mind claims do not qualify. Explicit operator approval is required. This synthetic dataset uses 2026-01-31 as its reference date.\n',
  });
  for (let i = 0; i < documents.length; i += 10)
    await Promise.all(
      documents.slice(i, i + 10).map(async (d) => {
        await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: d.key,
            Body: d.text,
            ContentType: 'text/plain',
          }),
        );
        await pool.query(
          'INSERT INTO desk.documents VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
          [d.id, d.order, d.kind, d.key, d.title],
        );
      }),
    );
  console.log(
    'Seeded 2,000 customers, 10,000 orders and 102 S3 documents; existing business writes preserved.',
  );
} finally {
  await pool.end();
  s3.destroy();
}
