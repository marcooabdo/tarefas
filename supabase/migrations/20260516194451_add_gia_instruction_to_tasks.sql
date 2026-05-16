/*
  # Add GIA instruction field to tasks

  1. Modified Tables
    - `tasks`
      - `gia_instruction` (text, nullable) - Instructions for GIA on how to handle the task.
        Examples: "just send a message", "track and ask for status", "send and mark complete"

  2. Notes
    - When gia_instruction is set, GIA uses it to decide behavior:
      - If instruction says to just send a message, GIA sends without asking for 1/2/3 response
      - If instruction says to track, GIA behaves as before (asks for status updates)
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tasks' AND column_name = 'gia_instruction'
  ) THEN
    ALTER TABLE tasks ADD COLUMN gia_instruction text DEFAULT '';
  END IF;
END $$;
