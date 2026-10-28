-- Phase 1 migration. Run ONCE in Postgres (pgAdmin / psql).

-- SAP-managed users (login + sync from SAP OUSR/OHEM)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS sap_user_code   VARCHAR(50),
  ADD COLUMN IF NOT EXISTS sap_user_id     INTEGER,
  ADD COLUMN IF NOT EXISTS sap_employee_id INTEGER,   -- OHEM.empID  (this column was MISSING - the timesheet bug)
  ADD COLUMN IF NOT EXISTS is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS role_override   VARCHAR(20),
  ADD COLUMN IF NOT EXISTS designation     VARCHAR(100),
  ADD COLUMN IF NOT EXISTS sap_synced_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_login_at   TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS users_sap_user_code_uq ON users (sap_user_code) WHERE sap_user_code IS NOT NULL;

-- Item info shown on the order screen (all from SAP)
ALTER TABLE items
  ADD COLUMN IF NOT EXISTS on_hand     NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unit_weight NUMERIC DEFAULT 0;   -- uom column already exists

-- Customer-specific discounts (SAP OSPP)
CREATE TABLE IF NOT EXISTS customer_discounts (
  card_code    VARCHAR NOT NULL,
  item_code    VARCHAR NOT NULL,
  discount_pct NUMERIC NOT NULL DEFAULT 0,
  PRIMARY KEY (card_code, item_code)
);

ALTER TABLE order_items ADD COLUMN IF NOT EXISTS discount_pct NUMERIC DEFAULT 0;
