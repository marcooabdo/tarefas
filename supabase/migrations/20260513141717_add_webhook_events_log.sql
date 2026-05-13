/*
  # Webhook events debug log

  1. New tables
    - `webhook_events`: registra TODO POST que chegou no webhook do WhatsApp.
      - `id` (uuid)
      - `received_at` (timestamptz)
      - `event` (text): nome do evento (ex.: messages.upsert)
      - `from_me` (boolean)
      - `remote_jid` (text)
      - `text` (text): conteúdo extraído
      - `payload` (jsonb): payload completo recebido
      - `outcome` (text): resultado do processamento (ignored / matched / no-match / button / error)
      - `notes` (text): observação adicional

  2. Security
    - RLS habilitada.
    - Apenas usuários autenticados podem ler (debug).
    - INSERT é feito pela edge function via service-role (RLS não se aplica).
*/

CREATE TABLE IF NOT EXISTS webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  received_at timestamptz NOT NULL DEFAULT now(),
  event text NOT NULL DEFAULT '',
  from_me boolean NOT NULL DEFAULT false,
  remote_jid text NOT NULL DEFAULT '',
  text text NOT NULL DEFAULT '',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  outcome text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT ''
);

ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated can read webhook events" ON webhook_events;
CREATE POLICY "Authenticated can read webhook events"
  ON webhook_events FOR SELECT
  TO authenticated
  USING (true);

CREATE INDEX IF NOT EXISTS webhook_events_received_at_idx ON webhook_events(received_at DESC);
