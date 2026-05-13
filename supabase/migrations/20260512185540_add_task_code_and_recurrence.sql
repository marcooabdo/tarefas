/*
  # Task code and recurrence

  1. Tables modified
    - `tasks`
      - `task_code` (text, unique): código humano amigável no formato ATOM-0001 para
        referência em mensagens. Gerado automaticamente via sequence + trigger.
      - `recurrence` (text, default 'none'): 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly'.
      - `recurrence_interval` (integer, default 1): a cada N unidades.

  2. Security
    - Mantém RLS existente. Nenhuma policy alterada.

  3. Notes
    1. Sequence `task_code_seq` gera números sequenciais.
    2. Trigger `set_task_code` preenche `task_code` se estiver nulo no INSERT.
    3. Preenche os códigos já existentes.
*/

CREATE SEQUENCE IF NOT EXISTS task_code_seq START 1000;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tasks' AND column_name = 'task_code'
  ) THEN
    ALTER TABLE tasks ADD COLUMN task_code text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tasks' AND column_name = 'recurrence'
  ) THEN
    ALTER TABLE tasks ADD COLUMN recurrence text NOT NULL DEFAULT 'none';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tasks' AND column_name = 'recurrence_interval'
  ) THEN
    ALTER TABLE tasks ADD COLUMN recurrence_interval integer NOT NULL DEFAULT 1;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION set_task_code()
RETURNS trigger AS $$
BEGIN
  IF NEW.task_code IS NULL OR NEW.task_code = '' THEN
    NEW.task_code := 'ATOM-' || lpad(nextval('task_code_seq')::text, 4, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_set_task_code ON tasks;
CREATE TRIGGER trg_set_task_code
  BEFORE INSERT ON tasks
  FOR EACH ROW EXECUTE FUNCTION set_task_code();

UPDATE tasks
SET task_code = 'ATOM-' || lpad(nextval('task_code_seq')::text, 4, '0')
WHERE task_code IS NULL OR task_code = '';

CREATE UNIQUE INDEX IF NOT EXISTS tasks_task_code_key ON tasks(task_code);
