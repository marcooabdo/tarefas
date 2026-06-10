export interface Contact {
  id: string;
  name: string;
  phone: string;
  country_code: string;
  department: string;
  active: boolean;
  is_group?: boolean;
  remote_jid?: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessageTemplate {
  id: string;
  name: string;
  content: string;
  variables: string[];
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Schedule {
  id: string;
  name: string;
  template_id: string | null;
  send_time: string;
  days_of_week: number[];
  active: boolean;
  contact_ids: string[] | null;
  send_once: boolean;
  created_at: string;
  updated_at: string;
  message_templates?: MessageTemplate;
}

export interface SendLog {
  id: string;
  contact_id: string | null;
  contact_name: string;
  contact_phone: string;
  template_id: string | null;
  template_name: string;
  message_content: string;
  status: 'sent' | 'error' | 'pending';
  error_message: string | null;
  sent_at: string;
  created_at: string;
}

export interface AppSetting {
  id: string;
  key: string;
  value: string;
  updated_at: string;
}

export type TaskStatus = 'pending' | 'in_progress' | 'awaiting_response' | 'completed';
export type TaskPriority = 'low' | 'medium' | 'high';
export type TaskRecurrence = 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly';

export const RECURRENCE_OPTIONS: { value: TaskRecurrence; label: string; hint: string }[] = [
  { value: 'none', label: 'Sem recorrência', hint: 'Tarefa única' },
  { value: 'daily', label: 'Diária', hint: 'Todos os dias' },
  { value: 'weekdays', label: 'Dias úteis', hint: 'Segunda a sexta' },
  { value: 'weekly', label: 'Semanal', hint: 'A cada 7 dias' },
  { value: 'monthly', label: 'Mensal', hint: 'A cada mês' },
];

export interface Task {
  id: string;
  task_code: string;
  title: string;
  description: string;
  assignee_name: string;
  assignee_phone: string;
  group_name: string;
  status: TaskStatus;
  priority: TaskPriority;
  due_date: string | null;
  ai_interventions: number;
  last_ai_nudge: string | null;
  completed_at: string | null;
  recurrence: TaskRecurrence;
  recurrence_interval: number;
  first_nudge_at: string | null;
  nudge_repeat_hours: number;
  nudge_active: boolean;
  gia_instruction: string;
  created_at: string;
  updated_at: string;
}

export const TASK_COLUMNS: { id: string; label: string; accent: string }[] = [
  { id: 'awaiting_response', label: 'IA Cobrando', accent: '#b347ff' },
  { id: 'recurring', label: 'Reincidentes', accent: '#ff9f0a' },
  { id: 'completed', label: 'Concluído', accent: '#10f59b' },
];

export const DAYS_OF_WEEK = [
  { value: 0, label: 'Dom' },
  { value: 1, label: 'Seg' },
  { value: 2, label: 'Ter' },
  { value: 3, label: 'Qua' },
  { value: 4, label: 'Qui' },
  { value: 5, label: 'Sex' },
  { value: 6, label: 'Sáb' },
];

export const COUNTRY_CODES = [
  { value: '+55', label: '+55 Brasil' },
  { value: '+1', label: '+1 EUA/Canadá' },
  { value: '+351', label: '+351 Portugal' },
  { value: '+54', label: '+54 Argentina' },
  { value: '+52', label: '+52 México' },
  { value: '+44', label: '+44 Reino Unido' },
  { value: '+49', label: '+49 Alemanha' },
  { value: '+33', label: '+33 França' },
  { value: '+34', label: '+34 Espanha' },
  { value: '+39', label: '+39 Itália' },
];
