/*
# Fix send_recurring_nudges to include auth header

## Problem
The send-task-nudge function requires JWT authentication (verify_jwt: true).
The previous version of send_recurring_nudges didn't include the Authorization header.

## Changes
- Add Authorization Bearer token (anon key) to the HTTP POST call
*/

CREATE OR REPLACE FUNCTION send_recurring_nudges()
RETURNS jsonb AS $$
DECLARE
  task_row RECORD;
  send_count INT := 0;
  base_url TEXT := 'https://rumghopkepljnlbioyll.supabase.co/functions/v1/send-task-nudge';
  auth_header TEXT := 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ1bWdob3BrZXBsam5sYmlveWxsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyOTYxMzgsImV4cCI6MjA5MTg3MjEzOH0.3Jtua9DH33t3O10OoKDvU0lr4IcY2_1V4Npzlrs_KV8';
BEGIN
  FOR task_row IN
    SELECT id, task_code, recurrence, last_ai_nudge
    FROM tasks
    WHERE nudge_active = true
      AND status NOT IN ('completed', 'cancelled')
      AND first_nudge_at <= NOW()
      AND recurrence IS NOT NULL
      AND recurrence != 'none'
    ORDER BY first_nudge_at ASC
    LIMIT 50
  LOOP
    PERFORM net.http_post(
      url := base_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', auth_header
      ),
      body := jsonb_build_object('task_id', task_row.id)
    );
    
    UPDATE tasks 
    SET last_ai_nudge = NOW(),
        ai_interventions = COALESCE(ai_interventions, 0) + 1
    WHERE id = task_row.id;
    
    send_count := send_count + 1;
  END LOOP;
  
  RETURN jsonb_build_object('sent', send_count);
END;
$$ LANGUAGE plpgsql;