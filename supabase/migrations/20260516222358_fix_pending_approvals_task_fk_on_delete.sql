/*
  # Fix foreign key constraint blocking task deletion

  1. Changes
    - Drop existing foreign key on `pending_message_approvals.task_id`
    - Re-create it with ON DELETE SET NULL so deleting a task does not fail
  
  2. Reason
    - When a task is deleted from the UI, the foreign key constraint blocks the deletion
      if any pending_message_approvals row references that task
*/

ALTER TABLE pending_message_approvals
  DROP CONSTRAINT IF EXISTS pending_message_approvals_task_id_fkey;

ALTER TABLE pending_message_approvals
  ADD CONSTRAINT pending_message_approvals_task_id_fkey
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL;
