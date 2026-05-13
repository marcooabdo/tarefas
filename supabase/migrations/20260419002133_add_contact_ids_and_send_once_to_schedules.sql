/*
  # Add contact_ids and send_once to schedules

  1. Changes to `schedules` table
    - `contact_ids` (uuid[], nullable) - list of specific contact IDs to send to; NULL means all active contacts
    - `send_once` (boolean, default false) - if true, schedule fires once immediately and does not repeat by time/day

  2. Notes
    - Existing schedules default to NULL contact_ids (send to all) and send_once = false (keep recurring behavior)
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'schedules' AND column_name = 'contact_ids'
  ) THEN
    ALTER TABLE schedules ADD COLUMN contact_ids uuid[] DEFAULT NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'schedules' AND column_name = 'send_once'
  ) THEN
    ALTER TABLE schedules ADD COLUMN send_once boolean NOT NULL DEFAULT false;
  END IF;
END $$;
