/*
  # Add per-task nudge scheduling

  1. New Columns on `tasks`
    - `first_nudge_at` (timestamptz) — when the first AI nudge should be sent
    - `nudge_repeat_hours` (int, default 0) — how often to repeat nudge while task remains open. 0 = single send.
    - `nudge_active` (bool, default true) — whether nudges are still active for this task

  2. Notes
    - Existing tasks default to `nudge_repeat_hours = 0` (single send, manual cobrança still works)
    - First nudge timestamp is opt-in, no automatic backfill
*/

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'tasks' AND column_name = 'first_nudge_at') THEN
    ALTER TABLE tasks ADD COLUMN first_nudge_at timestamptz;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'tasks' AND column_name = 'nudge_repeat_hours') THEN
    ALTER TABLE tasks ADD COLUMN nudge_repeat_hours integer NOT NULL DEFAULT 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'tasks' AND column_name = 'nudge_active') THEN
    ALTER TABLE tasks ADD COLUMN nudge_active boolean NOT NULL DEFAULT true;
  END IF;
END $$;
