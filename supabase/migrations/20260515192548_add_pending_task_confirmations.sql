/*
  # Add pending task confirmations table

  1. New Tables
    - `pending_task_confirmations`
      - `id` (uuid, primary key)
      - `owner_jid` (text) - the JID where confirmation was requested
      - `task_draft` (jsonb) - full task data to be created after confirmation
      - `candidates` (jsonb) - array of candidate contacts/groups found
      - `status` (text) - pending, confirmed, cancelled
      - `created_at` (timestamptz)
      - `resolved_at` (timestamptz)

  2. Security
    - Enable RLS on `pending_task_confirmations` table
    - Add policy for service role access (edge functions use service role)
*/

CREATE TABLE IF NOT EXISTS pending_task_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_jid text NOT NULL,
  task_draft jsonb NOT NULL DEFAULT '{}'::jsonb,
  candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz DEFAULT now(),
  resolved_at timestamptz
);

ALTER TABLE pending_task_confirmations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on pending_task_confirmations"
  ON pending_task_confirmations
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
