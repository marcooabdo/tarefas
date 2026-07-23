/*
# Auto-advance first_nudge_at for recurring tasks after nudge is sent

## Problem
The nudge-overdue-tasks edge function code has a bug where it doesn't properly
advance first_nudge_at for recurring daily tasks after sending. This causes
either: tasks to never fire again (first_nudge_at set too far in the future)
or tasks to fire repeatedly every 5 minutes (first_nudge_at stays in the past).

## Solution
A database trigger that fires AFTER UPDATE on tasks. When last_ai_nudge is 
updated on a recurring task, automatically set first_nudge_at to the next 
occurrence based on the recurrence type.

## Changes
- Create function `auto_advance_nudge_for_recurring()` 
- Create trigger on tasks table for AFTER UPDATE of last_ai_nudge

## Notes
- This runs in the database regardless of which edge function version is deployed
- Daily: next day at same time (12:00 UTC)
- Weekdays: next weekday at 12:00 UTC
- Weekly: +7 days
- Monthly: +1 month
*/

CREATE OR REPLACE FUNCTION auto_advance_nudge_for_recurring()
RETURNS TRIGGER AS $$
BEGIN
  -- Only act when last_ai_nudge was just updated
  IF NEW.last_ai_nudge IS DISTINCT FROM OLD.last_ai_nudge 
     AND NEW.last_ai_nudge IS NOT NULL
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
        -- Find next weekday
        NEW.first_nudge_at := (NOW() AT TIME ZONE 'UTC')::date + interval '1 day' + interval '12 hours';
        WHILE EXTRACT(DOW FROM NEW.first_nudge_at) IN (0, 6) LOOP
          NEW.first_nudge_at := NEW.first_nudge_at + interval '1 day';
        END LOOP;
      WHEN 'weekly' THEN
        NEW.first_nudge_at := NOW() + interval '7 days';
      WHEN 'monthly' THEN
        NEW.first_nudge_at := NOW() + interval '1 month';
      ELSE
        -- Unknown recurrence, don't change
        NULL;
    END CASE;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_auto_advance_nudge ON tasks;
CREATE TRIGGER trg_auto_advance_nudge
  BEFORE UPDATE ON tasks
  FOR EACH ROW
  EXECUTE FUNCTION auto_advance_nudge_for_recurring();