-- Migration: check-out flow + daily Time Sheet + photo requirement
-- Safe to re-run (idempotent) - matches existing schema.sql convention.

ALTER TABLE attendance ADD COLUMN IF NOT EXISTS check_out_at TIMESTAMPTZ;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS check_out_latitude NUMERIC;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS check_out_longitude NUMERIC;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS km_traveled NUMERIC;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS photo_url TEXT;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS orders_count INTEGER DEFAULT 0;

-- Tracks whether this day's record has already been pushed to SAP's
-- Time Sheet (OTSH) object - separate from the orders sync_status pattern,
-- since a Time Sheet record only becomes complete (and push-worthy) once
-- check-out has happened.
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS sap_synced BOOLEAN DEFAULT FALSE;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS sap_sync_error TEXT;
