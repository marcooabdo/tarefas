/*
# Auto-populate scheduled_send_at on approval

1. Changes
   - Creates a BEFORE UPDATE trigger on `pending_message_approvals`.
   - When a row transitions to `status = 'approved'`, checks
     `task_draft->>'scheduled_send'`. If it exists and is in the future,
     sets `scheduled_send_at` to that timestamp and `sent = false`.
   - This ensures the cron job `process-scheduled-sends` will pick up the
     message and send it at the correct time.

2. Important notes
   - This is a safety net: even if the webhook code doesn't set
     `scheduled_send_at`, the database will.
   - Does NOT prevent the webhook from sending immediately — that requires
     a webhook code change.
*/

CREATE OR REPLACE FUNCTION fn_auto_set_scheduled_send()
RETURNS trigger AS $$
DECLARE
  sched_text text;
  sched_ts timestamptz;
BEGIN
  IF NEW.status = 'approved' AND (OLD.status IS DISTINCT FROM 'approved') THEN
    sched_text := NEW.task_draft->>'scheduled_send';
    IF sched_text IS NOT NULL AND sched_text != '' THEN
      sched_ts := sched_text::timestamptz;
      IF sched_ts > now() THEN
        NEW.scheduled_send_at := sched_ts;
        NEW.sent := false;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_auto_set_scheduled_send ON pending_message_approvals;
CREATE TRIGGER trg_auto_set_scheduled_send
  BEFORE UPDATE ON pending_message_approvals
  FOR EACH ROW
  EXECUTE FUNCTION fn_auto_set_scheduled_send();
