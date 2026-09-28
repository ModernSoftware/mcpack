import pg from 'pg';
import { readFileSync } from 'node:fs';
export function database() {
  return new pg.Pool({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT ?? 5432),
    database: process.env.PGDATABASE ?? 'supportdesk',
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    max: 4,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    idleTimeoutMillis: 10000,
    ssl:
      process.env.DB_SSL === 'true'
        ? { rejectUnauthorized: true, ca: readFileSync(process.env.PGSSLROOTCERT, 'utf8') }
        : false,
  });
}
// PostgreSQL returns Date objects; the worker contract requires JSON values.
export function result(value) {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: JSON.parse(text) };
}
export const failure = (message) => ({ content: [{ type: 'text', text: message }], isError: true });
