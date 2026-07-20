/*
# Add scheduled_send_at column to pending_message_approvals

1. Changes
   - Adds `scheduled_send_at` (timestamptz, nullable) to store the time
     when an approved message should actually be sent.
   - When this column is NOT NULL and in the future, the webhook should
     NOT send immediately upon approval — instead, a cron job will pick
     it up at the right time.
   - Adds `sent` boolean column to track whether the scheduled message
     has already been sent (prevents double-sends).

2. Important notes
   - Existing rows keep NULL for both new columns (backward-compatible).
   - The webhook will be updated to populate `scheduled_send_at` from
     `task_draft->>'scheduled_send'` when approving.
*/

ALTER TABLE pending_message_approvals
  ADD COLUMN IF NOT EXISTS scheduled_send_at timestamptz DEFAULT NULL;

ALTER TABLE pending_message_approvals
  ADD COLUMN IF NOT EXISTS sent boolean NOT NULL DEFAULT false;

-- Backfill: mark all already-approved rows as sent (they were sent immediately)
UPDATE pending_message_approvals
  SET sent = true
  WHERE status = 'approved';
