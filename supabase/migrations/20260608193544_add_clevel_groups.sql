/*
# Add C-LEVEL Groups Management

1. New Tables
  - `clevel_groups`
    - `id` (uuid, primary key)
    - `contact_id` (uuid, FK to contacts, unique) - the WhatsApp group contact
    - `city` (text, not null) - city name (e.g. "Feira de Santana", "Montes Claros")
    - `label` (text) - optional extra label/description
    - `active` (boolean, default true)
    - `created_at` (timestamptz)
    - `updated_at` (timestamptz)

  - `clevel_broadcasts`
    - `id` (uuid, primary key)
    - `message` (text, not null) - the message sent
    - `cities` (text[], not null) - which cities were targeted
    - `deadline` (text) - optional deadline string included in message
    - `groups_targeted` (int) - how many groups received the message
    - `groups_sent` (int) - how many succeeded
    - `status` (text) - 'sent', 'partial', 'error'
    - `created_at` (timestamptz)

2. Security
  - RLS enabled on both tables with anon+authenticated CRUD (single-tenant app).

3. Notes
  - `clevel_groups.contact_id` has a UNIQUE constraint so each group can only be tagged once.
  - Index on `city` for fast filtering.
*/

CREATE TABLE IF NOT EXISTS clevel_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  city text NOT NULL,
  label text DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT clevel_groups_contact_id_key UNIQUE (contact_id)
);

CREATE INDEX IF NOT EXISTS idx_clevel_groups_city ON clevel_groups(city);

ALTER TABLE clevel_groups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_clevel_groups" ON clevel_groups;
CREATE POLICY "anon_select_clevel_groups" ON clevel_groups FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_clevel_groups" ON clevel_groups;
CREATE POLICY "anon_insert_clevel_groups" ON clevel_groups FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_clevel_groups" ON clevel_groups;
CREATE POLICY "anon_update_clevel_groups" ON clevel_groups FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_clevel_groups" ON clevel_groups;
CREATE POLICY "anon_delete_clevel_groups" ON clevel_groups FOR DELETE
  TO anon, authenticated USING (true);


CREATE TABLE IF NOT EXISTS clevel_broadcasts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message text NOT NULL,
  cities text[] NOT NULL,
  deadline text DEFAULT '',
  groups_targeted int NOT NULL DEFAULT 0,
  groups_sent int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz DEFAULT now()
);

ALTER TABLE clevel_broadcasts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_clevel_broadcasts" ON clevel_broadcasts;
CREATE POLICY "anon_select_clevel_broadcasts" ON clevel_broadcasts FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_clevel_broadcasts" ON clevel_broadcasts;
CREATE POLICY "anon_insert_clevel_broadcasts" ON clevel_broadcasts FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_clevel_broadcasts" ON clevel_broadcasts;
CREATE POLICY "anon_update_clevel_broadcasts" ON clevel_broadcasts FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_clevel_broadcasts" ON clevel_broadcasts;
CREATE POLICY "anon_delete_clevel_broadcasts" ON clevel_broadcasts FOR DELETE
  TO anon, authenticated USING (true);
