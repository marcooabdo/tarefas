/*
  # Add WhatsApp metadata columns to contacts

  1. Changes
    - Add `is_group` (boolean, default false) to contacts — distinguishes groups vs individuals
    - Add `remote_jid` (text, unique nullable) — stores Evolution API JID (e.g. 5511999999999@s.whatsapp.net or groupid@g.us)

  2. Notes
    - Existing contacts keep is_group=false automatically
    - remote_jid uniqueness prevents duplicate imports
*/

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='contacts' AND column_name='is_group') THEN
    ALTER TABLE contacts ADD COLUMN is_group boolean DEFAULT false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='contacts' AND column_name='remote_jid') THEN
    ALTER TABLE contacts ADD COLUMN remote_jid text;
    CREATE UNIQUE INDEX IF NOT EXISTS contacts_remote_jid_unique ON contacts(remote_jid) WHERE remote_jid IS NOT NULL;
  END IF;
END $$;
