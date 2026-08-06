-- =============================================================================
-- 0011 — Add pastoralist_location_history: full, permanent, append-only
-- record of every location change ever made for a herder.
--
-- Real incident driving this (2026-08-06): a WhatsApp tester told the bot
-- three different places across one conversation ("niko Ngare Mara", then
-- "Aldonyiro", then "niko shibli petrol station, iko bulla pesa") and the
-- bot's registered ward never budged — because nothing about a herder's
-- location is ever durably kept anywhere (only a 15-minute ephemeral
-- share, see grazing_ring_pending). Owner's explicit direction: location
-- must be permanently stored, changed only on an explicit new statement of
-- where the herder is, and the full history must never be deleted.
--
-- One row per location CHANGE (not a snapshot table) — modeled on
-- admin_audit_log's generic before/after shape rather than
-- ground_truth_corrections' per-field-row shape, since a location changes
-- as one compound value (ward + text + lat/lon together), not
-- independently-corrected fields.
--
-- `phone_number` is denormalized deliberately: a lead's `entity_id`
-- changes when promoted to a verified pastoralist (a different UUID), and
-- history must read as one continuous timeline across that boundary —
-- phone is the one stable join key.
--
-- IDEMPOTENT. Safe to re-run.
--
-- OPERATIONAL NOTE: unlike admin_audit_log (local-mirror-only, never
-- synced), this table's source of truth is Supabase — a herder's own
-- self-reported relocation has no `actor_sub`/`tenant_id` and must reach
-- the real data store per the owner's requirement above. Must ALSO be
-- applied directly against the live Supabase project (see
-- 0013_supabase_catchup2.supabase-only.sql) before it persists
-- server-side — same operational reality as every other Supabase-primary
-- table added this repo's history.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.pastoralist_location_history (
    id                      SERIAL PRIMARY KEY,
    entity_type             TEXT NOT NULL CHECK (entity_type IN ('lead', 'pastoralist')),
    entity_id               TEXT NOT NULL,
    phone_number            TEXT NOT NULL,
    ward_id                 TEXT,
    location_text           TEXT,
    lat                     DOUBLE PRECISION,
    lon                     DOUBLE PRECISION,
    source                  TEXT NOT NULL CHECK (source IN (
                                'ussd_registration', 'whatsapp_registration', 'sms_self',
                                'whatsapp_explicit_statement', 'ops_verification', 'ops_manual_edit')),
    confidence              TEXT CHECK (confidence IN ('high', 'medium', 'low')),
    previous_ward_id        TEXT,
    previous_location_text  TEXT,
    previous_lat            DOUBLE PRECISION,
    previous_lon            DOUBLE PRECISION,
    raw_message_text        TEXT,
    changed_by              TEXT,
    recorded_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pastoralist_location_history_entity
    ON public.pastoralist_location_history (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_pastoralist_location_history_phone
    ON public.pastoralist_location_history (phone_number, recorded_at DESC);

COMMIT;
