/*
  # WhatsApp Business Message Manager - Initial Schema

  ## Overview
  Creates all tables needed for the WhatsApp Business Automatic Message Management System.

  ## New Tables

  ### 1. contacts
  Stores contact information for message recipients.
  - `id` (uuid, primary key)
  - `name` (text) - full name of the contact
  - `phone` (text) - phone number in international format (e.g., +5511999999999)
  - `country_code` (text) - country dial code (e.g., +55)
  - `department` (text) - department or role of the contact
  - `active` (boolean) - whether the contact is active
  - `created_at` (timestamptz)
  - `updated_at` (timestamptz)

  ### 2. message_templates
  Stores reusable message templates with dynamic variable support.
  - `id` (uuid, primary key)
  - `name` (text) - template display name
  - `content` (text) - message body with variables like {nome}, {saudacao}
  - `variables` (text[]) - array of variable names used in the template
  - `active` (boolean)
  - `created_at` (timestamptz)
  - `updated_at` (timestamptz)

  ### 3. schedules
  Defines recurring send schedules linked to templates.
  - `id` (uuid, primary key)
  - `name` (text) - schedule display name
  - `template_id` (uuid, FK to message_templates)
  - `send_time` (text) - time in HH:mm format (e.g., "09:00")
  - `days_of_week` (integer[]) - array of ISO weekday numbers (0=Sun, 1=Mon...6=Sat)
  - `active` (boolean)
  - `created_at` (timestamptz)
  - `updated_at` (timestamptz)

  ### 4. send_logs
  Records every send attempt with success/failure tracking.
  - `id` (uuid, primary key)
  - `contact_id` (uuid, nullable FK to contacts)
  - `contact_name` (text) - denormalized for log history
  - `contact_phone` (text) - denormalized for log history
  - `template_id` (uuid, nullable FK to message_templates)
  - `template_name` (text) - denormalized for log history
  - `message_content` (text) - rendered message that was sent
  - `status` (text) - 'sent' | 'error' | 'pending'
  - `error_message` (text, nullable)
  - `sent_at` (timestamptz)
  - `created_at` (timestamptz)

  ### 5. app_settings
  Key-value store for application configuration (Evolution API credentials, etc).
  - `id` (uuid, primary key)
  - `key` (text, unique) - setting name
  - `value` (text) - setting value
  - `updated_at` (timestamptz)

  ## Security
  - RLS enabled on all tables
  - Public access policies (single-user app, no auth required for this internal tool)
    using anon role for all operations since this is an internal business tool

  ## Important Notes
  1. Phone numbers must be stored in international format with country code
  2. Variables in templates use {variable_name} syntax
  3. days_of_week uses 0-6 (0=Sunday, 6=Saturday)
  4. send_logs denormalizes contact/template info for historical accuracy
*/

CREATE TABLE IF NOT EXISTS contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  phone text NOT NULL,
  country_code text NOT NULL DEFAULT '+55',
  department text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS message_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  content text NOT NULL,
  variables text[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  template_id uuid REFERENCES message_templates(id) ON DELETE SET NULL,
  send_time text NOT NULL DEFAULT '09:00',
  days_of_week integer[] NOT NULL DEFAULT '{1,2,3,4,5}',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS send_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  contact_name text NOT NULL DEFAULT '',
  contact_phone text NOT NULL DEFAULT '',
  template_id uuid REFERENCES message_templates(id) ON DELETE SET NULL,
  template_name text NOT NULL DEFAULT '',
  message_content text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending',
  error_message text,
  sent_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text UNIQUE NOT NULL,
  value text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE send_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow anon read contacts"
  ON contacts FOR SELECT TO anon USING (true);

CREATE POLICY "Allow anon insert contacts"
  ON contacts FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "Allow anon update contacts"
  ON contacts FOR UPDATE TO anon USING (true) WITH CHECK (true);

CREATE POLICY "Allow anon delete contacts"
  ON contacts FOR DELETE TO anon USING (true);

CREATE POLICY "Allow anon read templates"
  ON message_templates FOR SELECT TO anon USING (true);

CREATE POLICY "Allow anon insert templates"
  ON message_templates FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "Allow anon update templates"
  ON message_templates FOR UPDATE TO anon USING (true) WITH CHECK (true);

CREATE POLICY "Allow anon delete templates"
  ON message_templates FOR DELETE TO anon USING (true);

CREATE POLICY "Allow anon read schedules"
  ON schedules FOR SELECT TO anon USING (true);

CREATE POLICY "Allow anon insert schedules"
  ON schedules FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "Allow anon update schedules"
  ON schedules FOR UPDATE TO anon USING (true) WITH CHECK (true);

CREATE POLICY "Allow anon delete schedules"
  ON schedules FOR DELETE TO anon USING (true);

CREATE POLICY "Allow anon read logs"
  ON send_logs FOR SELECT TO anon USING (true);

CREATE POLICY "Allow anon insert logs"
  ON send_logs FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "Allow anon update logs"
  ON send_logs FOR UPDATE TO anon USING (true) WITH CHECK (true);

CREATE POLICY "Allow anon delete logs"
  ON send_logs FOR DELETE TO anon USING (true);

CREATE POLICY "Allow anon read settings"
  ON app_settings FOR SELECT TO anon USING (true);

CREATE POLICY "Allow anon insert settings"
  ON app_settings FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "Allow anon update settings"
  ON app_settings FOR UPDATE TO anon USING (true) WITH CHECK (true);

CREATE POLICY "Allow anon delete settings"
  ON app_settings FOR DELETE TO anon USING (true);

INSERT INTO app_settings (key, value) VALUES
  ('evolution_api_url', ''),
  ('evolution_api_key', ''),
  ('evolution_instance_name', '')
ON CONFLICT (key) DO NOTHING;
