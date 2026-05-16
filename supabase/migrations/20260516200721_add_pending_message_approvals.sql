/*
  # Add pending message approvals table

  1. New Tables
    - `pending_message_approvals`
      - `id` (uuid, primary key)
      - `owner_jid` (text) - WhatsApp JID of the owner who requested
      - `task_id` (uuid, nullable) - reference to the task if already created
      - `task_draft` (jsonb) - full task data to create after approval
      - `proposed_message` (text) - message GIA proposes to send
      - `assignee_name` (text) - resolved contact name
      - `assignee_phone` (text) - resolved phone/jid
      - `status` (text) - pending/approved/rejected
      - `created_at` (timestamptz)
      - `resolved_at` (timestamptz, nullable)

  2. Security
    - Enable RLS on `pending_message_approvals`
    - Add policy for service role access (edge functions use service role key)
*/

CREATE TABLE IF NOT EXISTS pending_message_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_jid text NOT NULL,
  task_id uuid REFERENCES tasks(id),
  task_draft jsonb NOT NULL DEFAULT '{}'::jsonb,
  proposed_message text NOT NULL DEFAULT '',
  assignee_name text NOT NULL DEFAULT '',
  assignee_phone text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

ALTER TABLE pending_message_approvals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on pending_message_approvals"
  ON pending_message_approvals
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
