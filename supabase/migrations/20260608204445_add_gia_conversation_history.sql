CREATE TABLE IF NOT EXISTS gia_conversation_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_jid text NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE gia_conversation_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_full_access" ON gia_conversation_history
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX idx_gia_conv_owner_created ON gia_conversation_history (owner_jid, created_at DESC);
