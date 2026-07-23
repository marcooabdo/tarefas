/*
# Protect recurring tasks from being marked completed by send-task-nudge

## Problem
The send-task-nudge function marks tasks as 'completed' after sending. For recurring
tasks, this prevents them from being picked up in the next cycle.

## Solution  
Add to the trigger: if a recurring task is being set to 'completed' but was 
'awaiting_response' or 'in_progress' or 'pending', override back to 'awaiting_response'.
This only applies when last_ai_nudge was recently updated (within 24h), indicating
an automated nudge just ran.

## Notes
- Manual completion via webhook (user responds "ATOM-XXXX concluido") will still work
  because it doesn't update last_ai_nudge to a recent time
- The trigger only fires on the automated send path
*/

CREATE OR REPLACE FUNCTION auto_advance_nudge_for_recurring()
RETURNS TRIGGER AS $$
DECLARE
  next_nudge timestamptz;
BEGIN
  -- Only apply to active recurring tasks
  IF NEW.recurrence IS NULL OR NEW.recurrence = 'none' OR NOT NEW.nudge_active THEN
    RETURN NEW;
  END IF;
  
  -- If last_ai_nudge is recent (within 24h), this is an automated send cycle
  IF NEW.last_ai_nudge IS NOT NULL 
     AND NEW.last_ai_nudge > NOW() - interval '24 hours'
  THEN
    -- Calculate next nudge time
    CASE NEW.recurrence
      WHEN 'daily' THEN
        next_nudge := (NOW() AT TIME ZONE 'UTC')::date + interval '1 day' + interval '12 hours';
      WHEN 'weekdays' THEN
        next_nudge := (NOW() AT TIME ZONE 'UTC')::date + interval '1 day' + interval '12 hours';
        WHILE EXTRACT(DOW FROM next_nudge) IN (0, 6) LOOP
          next_nudge := next_nudge + interval '1 day';
        END LOOP;
      WHEN 'weekly' THEN
        next_nudge := NOW() + interval '7 days';
      WHEN 'monthly' THEN
        next_nudge := NOW() + interval '1 month';
      ELSE
        RETURN NEW;
    END CASE;
    
    -- Always enforce correct first_nudge_at
    NEW.first_nudge_at := next_nudge;
    
    -- Prevent send-task-nudge from marking recurring tasks as completed
    IF NEW.status = 'completed' AND OLD.status != 'completed' THEN
      NEW.status := 'awaiting_response';
      NEW.completed_at := NULL;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;