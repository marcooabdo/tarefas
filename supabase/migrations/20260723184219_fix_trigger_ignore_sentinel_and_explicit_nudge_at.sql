/*
# Fix trigger to not fire on sentinel value updates

## Problem
The trigger auto_advance_nudge_for_recurring fires when last_ai_nudge changes
from NULL to the sentinel '1970-01-01', which is not an actual nudge send.
Also the trigger shouldn't fire when first_nudge_at is set in the same UPDATE 
(to avoid overriding intentional resets).

## Changes
- Add condition: only fire if NEW.last_ai_nudge > '2020-01-01' (not a sentinel)
- Only fire if OLD.first_nudge_at = NEW.first_nudge_at (wasn't explicitly changed)
*/

CREATE OR REPLACE FUNCTION auto_advance_nudge_for_recurring()
RETURNS TRIGGER AS $$
BEGIN
  -- Only act when last_ai_nudge was just updated to a REAL timestamp (not sentinel)
  -- and the caller didn't explicitly set first_nudge_at in the same UPDATE
  IF NEW.last_ai_nudge IS DISTINCT FROM OLD.last_ai_nudge 
     AND NEW.last_ai_nudge IS NOT NULL
     AND NEW.last_ai_nudge > '2020-01-01T00:00:00Z'::timestamptz
     AND NEW.recurrence IS NOT NULL
     AND NEW.recurrence != 'none'
     AND NEW.nudge_active = true
     AND NEW.first_nudge_at IS NOT DISTINCT FROM OLD.first_nudge_at
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