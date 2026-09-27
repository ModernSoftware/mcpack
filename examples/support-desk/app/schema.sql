CREATE SCHEMA IF NOT EXISTS desk;
CREATE TABLE IF NOT EXISTS desk.dataset (id integer PRIMARY KEY CHECK (id=1), as_of date NOT NULL);
CREATE TABLE IF NOT EXISTS desk.customers (id text PRIMARY KEY, name text NOT NULL, email text NOT NULL);
CREATE TABLE IF NOT EXISTS desk.orders (id text PRIMARY KEY, customer_id text NOT NULL REFERENCES desk.customers,
 status text NOT NULL, total_cents integer NOT NULL CHECK(total_cents>0), delivered_at date);
CREATE INDEX IF NOT EXISTS orders_customer ON desk.orders(customer_id,id);
CREATE TABLE IF NOT EXISTS desk.order_items (order_id text REFERENCES desk.orders, sku text, quantity integer, PRIMARY KEY(order_id,sku));
CREATE TABLE IF NOT EXISTS desk.shipment_events (order_id text REFERENCES desk.orders, event text, occurred_at date, PRIMARY KEY(order_id,event));
CREATE TABLE IF NOT EXISTS desk.rejection_reasons (code text PRIMARY KEY, explanation text NOT NULL);
CREATE TABLE IF NOT EXISTS desk.claims (id text PRIMARY KEY, order_id text NOT NULL REFERENCES desk.orders,
 reason text NOT NULL CHECK(reason IN ('damaged','missing','changed_mind')), status text NOT NULL,
 rejection_code text REFERENCES desk.rejection_reasons, request_key text UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS desk.documents (id text PRIMARY KEY, order_id text REFERENCES desk.orders,
 kind text NOT NULL, object_key text UNIQUE NOT NULL, title text NOT NULL);
CREATE TABLE IF NOT EXISTS desk.refunds (id text PRIMARY KEY, claim_id text UNIQUE NOT NULL REFERENCES desk.claims,
 idempotency_key text UNIQUE NOT NULL, amount_cents integer NOT NULL, status text NOT NULL, created_at timestamptz DEFAULT now());
