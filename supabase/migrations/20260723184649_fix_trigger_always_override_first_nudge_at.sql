/*
# Fix trigger to ALWAYS override first_nudge_at for recurring tasks

## Problem
The send-task-nudge function also updates first_nudge_at (with the wrong value,
based on due_date). The trigger condition NEW.first_nudge_at IS NOT DISTINCT FROM 
OLD.first_nudge_at prevented the trigger from overriding this wrong value.

## Solution
Remove that condition. The trigger always sets first_nudge_at to next occurrence
based on NOW() whenever last_ai_nudge changes on a recurring task.
*/

CREATE OR REPLACE FUNCTION auto_advance_nudge_for_recurring()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.last_ai_nudge IS DISTINCT FROM OLD.last_ai_nudge 
     AND NEW.last_ai_nudge IS NOT NULL
     AND NEW.last_ai_nudge > '2020-01-01T00:00:00Z'::timestamptz
     AND NEW.recurrence IS NOT NULL
     AND NEW.recurrence != 'none'
     AND NEW.nudge_active = true
  THEN
    CASE NEW.recurrence
      WHEN 'daily' THEN
        NEW.first_nudge_at := (NOW() AT TIME ZONE 'UTC')::date 
          + interval '1 day' 
          + interval '12 hours';
      WHEN 'weekdays' THEN
        NEW.first_nudge_at := (NOW() AT TIME ZONE 'UTC')::date + interval '1 day' + interval '12 hours';
        WHILE EXTRACT(DOW FROM NEW.first_nudge_at) IN (0, 6) LOOP
          NEW.first_nudge_at := NEW.first_nudge_at + interval '1 day';
        END LOOP;
      WHEN 'weekly' THEN
        NEW.first_nudge_at := NOW() + interval '7 days';
      WHEN 'monthly' THEN
        NEW.first_nudge_at := NOW() + interval '1 month';
      ELSE
        NULL;
    END CASE;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;