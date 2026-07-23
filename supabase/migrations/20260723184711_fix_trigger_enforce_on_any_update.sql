/*
# Make trigger enforce first_nudge_at on ANY update to recurring tasks

## Problem
The send-task-nudge edge function asynchronously updates tasks AFTER the trigger
runs, overwriting first_nudge_at with wrong values. Need to ensure first_nudge_at 
is ALWAYS correct after any update.

## Solution
The trigger fires on ANY update to a recurring task and enforces:
- If last_ai_nudge was updated today, first_nudge_at = tomorrow 12:00 UTC
- This catches both the local UPDATE and the async send-task-nudge UPDATE
*/

CREATE OR REPLACE FUNCTION auto_advance_nudge_for_recurring()
RETURNS TRIGGER AS $$
DECLARE
  tomorrow_noon timestamptz;
BEGIN
  -- Only apply to active recurring tasks
  IF NEW.recurrence IS NULL OR NEW.recurrence = 'none' OR NOT NEW.nudge_active THEN
    RETURN NEW;
  END IF;
  
  -- If last_ai_nudge was set to today (within last 24h), enforce tomorrow as next
  IF NEW.last_ai_nudge IS NOT NULL 
     AND NEW.last_ai_nudge > NOW() - interval '24 hours'
  THEN
    CASE NEW.recurrence
      WHEN 'daily' THEN
        tomorrow_noon := (NOW() AT TIME ZONE 'UTC')::date + interval '1 day' + interval '12 hours';
      WHEN 'weekdays' THEN
        tomorrow_noon := (NOW() AT TIME ZONE 'UTC')::date + interval '1 day' + interval '12 hours';
        WHILE EXTRACT(DOW FROM tomorrow_noon) IN (0, 6) LOOP
          tomorrow_noon := tomorrow_noon + interval '1 day';
        END LOOP;
      WHEN 'weekly' THEN
        tomorrow_noon := NOW() + interval '7 days';
      WHEN 'monthly' THEN
        tomorrow_noon := NOW() + interval '1 month';
      ELSE
        RETURN NEW;
    END CASE;
    
    NEW.first_nudge_at := tomorrow_noon;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;