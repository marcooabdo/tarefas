import { useEffect, useMemo, useState } from 'react';
import { Plus, Phone, Users as Users2, Clock, Zap, CircleAlert as AlertCircle, Flame, Trash2, Send, LayoutGrid, List as ListIcon, X, Search, Check, Repeat, Pencil } from 'lucide-react';
import { supabase } from '../lib/supabase';
import type { Task, TaskPriority, TaskStatus, TaskRecurrence, Contact } from '../lib/types';
import { TASK_COLUMNS, RECURRENCE_OPTIONS } from '../lib/types';

const priorityIcon: Record<TaskPriority, typeof Flame> = {
  high: Flame,
  medium: Zap,
  low: AlertCircle,
};

const priorityLabel: Record<TaskPriority, string> = {
  high: 'Alta',
  medium: 'Média',
  low: 'Baixa',
};

function formatDue(iso: string | null) {
  if (!iso) return 'Sem prazo';
  const d = new Date(iso);
  const diffDays = Math.ceil((d.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return `${Math.abs(diffDays)}d atrasada`;
  if (diffDays === 0) return 'Hoje';
  if (diffDays === 1) return 'Amanhã';
  return `em ${diffDays}d`;
}

function isOverdue(t: Task) {
  return t.status !== 'completed' && t.due_date && new Date(t.due_date).getTime() < Date.now();
}

interface Draft {
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  due_date: string;
  recipient_ids: string[];
  recurrence: TaskRecurrence;
  recurrence_interval: number;
  first_nudge_at: string;
  nudge_repeat_hours: number;
}

function defaultFirstNudge(): string {
  const d = new Date();
  d.setHours(d.getHours() + 1, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const emptyDraft: Draft = {
  title: '',
  description: '',
  status: 'pending',
  priority: 'medium',
  due_date: '',
  recipient_ids: [],
  recurrence: 'none',
  recurrence_interval: 1,
  first_nudge_at: '',
  nudge_repeat_hours: 0,
};

const RECURRENCE_LABEL: Record<TaskRecurrence, string> = {
  none: 'Sem recorrência',
  daily: 'Diária',
  weekdays: 'Dias úteis',
  weekly: 'Semanal',
  monthly: 'Mensal',
};

export function Tasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'kanban' | 'list'>('kanban');
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [nudgingId, setNudgingId] = useState<string | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [recipientSearch, setRecipientSearch] = useState('');
  const [recipientFilter, setRecipientFilter] = useState<'all' | 'groups' | 'contacts'>('all');

  useEffect(() => { load(); loadContacts(); }, []);

  async function load() {
    setLoading(true);
    const { data } = await supabase.from('tasks').select('*').order('created_at', { ascending: false });
    setTasks((data as Task[]) ?? []);
    setLoading(false);
  }

  async function loadContacts() {
    const { data } = await supabase.from('contacts').select('*').eq('active', true).order('name');
    setContacts((data as Contact[]) ?? []);
  }

  function openCreateTask() {
    setEditingId(null);
    setDraft({ ...emptyDraft, first_nudge_at: defaultFirstNudge() });
    setRecipientSearch('');
    setRecipientFilter('all');
    setModalOpen(true);
  }

  function openEditTask(t: Task) {
    setEditingId(t.id);
    const pad = (n: number) => String(n).padStart(2, '0');
    const toLocalInput = (iso: string | null) => {
      if (!iso) return '';
      const d = new Date(iso);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    const toLocalDate = (iso: string | null) => {
      if (!iso) return '';
      const d = new Date(iso);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };
    setDraft({
      title: t.title,
      description: t.description ?? '',
      status: t.status,
      priority: t.priority,
      due_date: toLocalDate(t.due_date),
      recipient_ids: [],
      recurrence: t.recurrence,
      recurrence_interval: t.recurrence_interval ?? 1,
      first_nudge_at: toLocalInput(t.first_nudge_at),
      nudge_repeat_hours: t.nudge_repeat_hours ?? 0,
    });
    setRecipientSearch('');
    setRecipientFilter('all');
    setModalOpen(true);
  }

  function toggleRecipient(id: string) {
    setDraft((prev) => {
      const has = prev.recipient_ids.includes(id);
      return { ...prev, recipient_ids: has ? prev.recipient_ids.filter((x) => x !== id) : [...prev.recipient_ids, id] };
    });
  }

  const filteredContactList = contacts.filter((c) => {
    if (recipientFilter === 'groups' && !c.is_group) return false;
    if (recipientFilter === 'contacts' && c.is_group) return false;
    if (!recipientSearch.trim()) return true;
    const q = recipientSearch.toLowerCase();
    return c.name.toLowerCase().includes(q) || c.phone.includes(recipientSearch) || (c.department ?? '').toLowerCase().includes(q);
  });

  const selectedRecipients = contacts.filter((c) => draft.recipient_ids.includes(c.id));

  const grouped = useMemo(() => {
    const map: Record<TaskStatus, Task[]> = {
      pending: [], in_progress: [], awaiting_response: [], completed: [],
    };
    tasks.forEach((t) => { map[t.status]?.push(t); });
    return map;
  }, [tasks]);

  async function saveTask() {
    if (!draft.title.trim()) return;
    if (!editingId && draft.recipient_ids.length === 0) return;
    setSaving(true);
    const due = draft.due_date ? new Date(draft.due_date).toISOString() : null;
    const firstNudge = draft.first_nudge_at ? new Date(draft.first_nudge_at).toISOString() : null;

    if (editingId) {
      await supabase
        .from('tasks')
        .update({
          title: draft.title,
          description: draft.description,
          status: draft.status,
          priority: draft.priority,
          due_date: due,
          recurrence: draft.recurrence,
          recurrence_interval: draft.recurrence_interval,
          first_nudge_at: firstNudge,
          nudge_repeat_hours: draft.nudge_repeat_hours,
          nudge_active: !!firstNudge,
        })
        .eq('id', editingId);
    } else {
      const recipients = contacts.filter((c) => draft.recipient_ids.includes(c.id));
      const rows = recipients.map((r) => ({
        title: draft.title,
        description: draft.description,
        assignee_name: r.name,
        assignee_phone: r.phone,
        group_name: r.is_group ? r.name : (r.department || ''),
        status: draft.status,
        priority: draft.priority,
        due_date: due,
        recurrence: draft.recurrence,
        recurrence_interval: draft.recurrence_interval,
        first_nudge_at: firstNudge,
        nudge_repeat_hours: draft.nudge_repeat_hours,
        nudge_active: !!firstNudge,
      }));
      await supabase.from('tasks').insert(rows);
    }

    setSaving(false);
    setModalOpen(false);
    setEditingId(null);
    setDraft(emptyDraft);
    load();
  }

  async function moveTask(id: string, status: TaskStatus) {
    const updates: Partial<Task> = { status };
    if (status === 'completed') updates.completed_at = new Date().toISOString();
    await supabase.from('tasks').update(updates).eq('id', id);
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...updates } : t)));
  }

  async function forceAiNudge(t: Task) {
    setNudgingId(t.id);
    try {
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/send-task-nudge`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ task_id: t.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(`Falha no envio: ${data?.error ?? res.statusText}`);
      }
    } catch (e: any) {
      alert(`Erro de rede: ${e?.message ?? 'desconhecido'}`);
    } finally {
      setNudgingId(null);
      load();
    }
  }

  async function removeTask(id: string) {
    await supabase.from('tasks').delete().eq('id', id);
    setTasks((prev) => prev.filter((t) => t.id !== id));
  }

  function TaskCard({ t }: { t: Task }) {
    const PIcon = priorityIcon[t.priority];
    const overdue = isOverdue(t);
    return (
      <div className="task-card" style={{ padding: '14px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0, flex: 1 }}>
            {t.task_code && (
              <div style={{ fontSize: '10px', fontWeight: 700, color: '#00e5ff', letterSpacing: '1px', fontFamily: 'monospace' }}>
                {t.task_code}
              </div>
            )}
            <div style={{ fontSize: '13.5px', fontWeight: 600, color: '#f4f6fb', lineHeight: 1.35, letterSpacing: '-0.1px' }}>
              {t.title}
            </div>
          </div>
          <span className={`chip priority-${t.priority}`}>
            <PIcon size={11} />
            {priorityLabel[t.priority]}
          </span>
        </div>

        {t.recurrence && t.recurrence !== 'none' && (
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: '5px', alignSelf: 'flex-start',
            fontSize: '10.5px', fontWeight: 600, padding: '3px 8px', borderRadius: '10px',
            background: 'rgba(16,245,155,0.1)', border: '1px solid rgba(16,245,155,0.3)', color: '#10f59b',
          }}>
            <Repeat size={10} />
            {RECURRENCE_LABEL[t.recurrence]}
          </div>
        )}

        {t.description && (
          <div style={{ fontSize: '12px', color: '#9aa3b2', lineHeight: 1.5 }}>
            {t.description}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', fontSize: '11.5px', color: '#c6cdda' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Users2 size={12} color="#6b7384" />
            <span>{t.assignee_name}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Phone size={12} color="#6b7384" />
            <span style={{ fontFamily: 'monospace' }}>{t.assignee_phone}</span>
          </div>
          {t.group_name && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ color: '#6b7384' }}>#</span>
              <span>{t.group_name}</span>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: overdue ? '#ff4d79' : '#9aa3b2', fontWeight: 500 }}>
            <Clock size={12} />
            {formatDue(t.due_date)}
          </div>
          {t.ai_interventions > 0 && (
            <span className="chip" style={{ background: 'rgba(179,71,255,0.12)', color: '#b347ff', border: '1px solid rgba(179,71,255,0.3)' }}>
              <Zap size={10} />
              {t.ai_interventions}x IA
            </span>
          )}
        </div>

        <div style={{ display: 'flex', gap: '6px' }}>
          <button
            onClick={() => forceAiNudge(t)}
            disabled={nudgingId === t.id || t.status === 'completed'}
            className="neon-btn"
            style={{ flex: 1, padding: '8px 10px', fontSize: '11.5px', justifyContent: 'center' }}
          >
            <Send size={12} />
            {nudgingId === t.id ? 'Enviando...' : 'Cobrar via IA'}
          </button>
          <button
            onClick={() => openEditTask(t)}
            className="ghost-btn"
            style={{ padding: '8px 10px' }}
            aria-label="Editar"
            title="Editar"
          >
            <Pencil size={13} />
          </button>
          <button
            onClick={() => removeTask(t.id)}
            className="ghost-btn"
            style={{ padding: '8px 10px' }}
            aria-label="Remover"
            title="Remover"
          >
            <Trash2 size={13} />
          </button>
        </div>

        <select
          value={t.status}
          onChange={(e) => moveTask(t.id, e.target.value as TaskStatus)}
          style={{
            background: 'rgba(255,255,255,0.04)',
            color: '#c6cdda',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: '8px',
            padding: '6px 8px',
            fontSize: '11px',
            cursor: 'pointer',
          }}
        >
          {TASK_COLUMNS.map((c) => (
            <option key={c.id} value={c.id} style={{ background: '#0e1016' }}>
              Mover para: {c.label}
            </option>
          ))}
        </select>
      </div>
    );
  }

  return (
    <div style={{ padding: '32px 36px', maxWidth: '1600px', margin: '0 auto' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '28px', flexWrap: 'wrap', gap: '16px' }}>
        <div>
          <div style={{ fontSize: '11px', color: '#6b7384', letterSpacing: '2px', textTransform: 'uppercase', fontWeight: 600, marginBottom: '6px' }}>
            Workflow Operacional
          </div>
          <h1 style={{ fontSize: '32px', fontWeight: 700, color: '#f4f6fb', margin: 0, letterSpacing: '-0.5px' }}>
            Gestor de Tarefas
          </h1>
          <p style={{ color: '#9aa3b2', margin: '6px 0 0', fontSize: '14px' }}>
            Kanban integrado: a IA envia cobranças reais via Evolution API e atualiza o status ao receber respostas no webhook.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '10px' }}>
          <div className="glass" style={{ padding: '4px', display: 'flex', gap: '2px' }}>
            <button
              onClick={() => setView('kanban')}
              className="ghost-btn"
              style={{
                border: 'none',
                background: view === 'kanban' ? 'rgba(0,229,255,0.15)' : 'transparent',
                color: view === 'kanban' ? '#00e5ff' : '#9aa3b2',
                padding: '8px 12px',
              }}
            >
              <LayoutGrid size={14} /> Kanban
            </button>
            <button
              onClick={() => setView('list')}
              className="ghost-btn"
              style={{
                border: 'none',
                background: view === 'list' ? 'rgba(0,229,255,0.15)' : 'transparent',
                color: view === 'list' ? '#00e5ff' : '#9aa3b2',
                padding: '8px 12px',
              }}
            >
              <ListIcon size={14} /> Lista
            </button>
          </div>
          <button onClick={openCreateTask} className="neon-btn">
            <Plus size={14} /> Nova Tarefa
          </button>
        </div>
      </header>

      {loading ? (
        <div style={{ padding: '60px', textAlign: 'center', color: '#6b7384' }}>Carregando tarefas...</div>
      ) : view === 'kanban' ? (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, minmax(260px, 1fr))',
            gap: '16px',
            overflowX: 'auto',
          }}
        >
          {TASK_COLUMNS.map((col) => (
            <div key={col.id} className="kanban-col" style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px', minHeight: '300px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingBottom: '10px', borderBottom: `1px solid ${col.accent}25` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: col.accent, boxShadow: `0 0 10px ${col.accent}` }} />
                  <span style={{ fontSize: '12px', fontWeight: 600, color: '#f4f6fb', letterSpacing: '0.2px' }}>
                    {col.label}
                  </span>
                </div>
                <span style={{ fontSize: '11px', color: '#6b7384', fontWeight: 600, background: 'rgba(255,255,255,0.05)', padding: '2px 8px', borderRadius: '8px' }}>
                  {grouped[col.id].length}
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {grouped[col.id].length === 0 ? (
                  <div style={{ color: '#6b7384', fontSize: '12px', textAlign: 'center', padding: '20px 0' }}>
                    Nenhuma tarefa
                  </div>
                ) : (
                  grouped[col.id].map((t) => <TaskCard key={t.id} t={t} />)
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="glass" style={{ padding: '0', overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'rgba(255,255,255,0.03)' }}>
                {['Tarefa', 'Responsável', 'WhatsApp', 'Prazo', 'Status', 'IA', 'Ações'].map((h) => (
                  <th key={h} style={{ padding: '14px 16px', textAlign: 'left', fontSize: '11px', color: '#6b7384', fontWeight: 600, letterSpacing: '0.6px', textTransform: 'uppercase' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => (
                <tr key={t.id} style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                  <td style={{ padding: '14px 16px', fontSize: '13px', color: '#f4f6fb', fontWeight: 500 }}>
                    {t.task_code && <div style={{ fontSize: '10px', color: '#00e5ff', fontWeight: 700, letterSpacing: '1px', fontFamily: 'monospace', marginBottom: '2px' }}>{t.task_code}</div>}
                    {t.title}
                    {t.recurrence && t.recurrence !== 'none' && (
                      <span style={{ marginLeft: '8px', fontSize: '10px', color: '#10f59b', fontWeight: 600 }}>
                        · {RECURRENCE_LABEL[t.recurrence]}
                      </span>
                    )}
                  </td>
                  <td style={{ padding: '14px 16px', fontSize: '12.5px', color: '#c6cdda' }}>{t.assignee_name}</td>
                  <td style={{ padding: '14px 16px', fontSize: '12px', color: '#9aa3b2', fontFamily: 'monospace' }}>{t.assignee_phone}</td>
                  <td style={{ padding: '14px 16px', fontSize: '12px', color: isOverdue(t) ? '#ff4d79' : '#9aa3b2' }}>{formatDue(t.due_date)}</td>
                  <td style={{ padding: '14px 16px' }}>
                    <span className="chip" style={{ background: 'rgba(255,255,255,0.05)', color: '#c6cdda', border: '1px solid rgba(255,255,255,0.1)' }}>
                      {TASK_COLUMNS.find((c) => c.id === t.status)?.label}
                    </span>
                  </td>
                  <td style={{ padding: '14px 16px', fontSize: '12px', color: '#b347ff', fontWeight: 600 }}>{t.ai_interventions}x</td>
                  <td style={{ padding: '14px 16px' }}>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button
                        onClick={() => forceAiNudge(t)}
                        disabled={nudgingId === t.id || t.status === 'completed'}
                        className="neon-btn"
                        style={{ padding: '6px 10px', fontSize: '11px' }}
                      >
                        <Send size={11} /> Cobrar
                      </button>
                      <button
                        onClick={() => openEditTask(t)}
                        className="ghost-btn"
                        style={{ padding: '6px 8px' }}
                        aria-label="Editar"
                        title="Editar"
                      >
                        <Pencil size={12} />
                      </button>
                      <button
                        onClick={() => removeTask(t.id)}
                        className="ghost-btn"
                        style={{ padding: '6px 8px' }}
                        aria-label="Remover"
                        title="Remover"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modalOpen && (
        <div
          onClick={() => setModalOpen(false)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(4, 5, 9, 0.75)',
            backdropFilter: 'blur(6px)', zIndex: 100,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '20px',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="glass"
            style={{ width: '100%', maxWidth: '620px', padding: '28px', maxHeight: '90vh', overflowY: 'auto' }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h2 style={{ fontSize: '20px', fontWeight: 700, color: '#f4f6fb', margin: 0 }}>{editingId ? 'Editar Tarefa' : 'Nova Tarefa'}</h2>
              <button onClick={() => setModalOpen(false)} className="ghost-btn" style={{ padding: '6px' }}>
                <X size={16} />
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <Field label="Título">
                <input
                  className="nx-input"
                  value={draft.title}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  placeholder="Ex: Finalizar relatório de vendas"
                />
              </Field>
              <Field label="Descrição">
                <textarea
                  className="nx-input"
                  rows={3}
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  placeholder="Contexto ou detalhes da tarefa"
                />
              </Field>

              {!editingId && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <span style={{ fontSize: '11px', color: '#9aa3b2', fontWeight: 600, letterSpacing: '0.4px', textTransform: 'uppercase' }}>
                    Destinatários <span style={{ color: '#00e5ff', marginLeft: '4px' }}>{draft.recipient_ids.length > 0 ? `(${draft.recipient_ids.length})` : ''}</span>
                  </span>
                  <div style={{ display: 'flex', gap: '5px' }}>
                    {(['all', 'contacts', 'groups'] as const).map((f) => {
                      const active = recipientFilter === f;
                      return (
                        <button
                          key={f}
                          type="button"
                          onClick={() => setRecipientFilter(f)}
                          style={{
                            padding: '4px 10px', borderRadius: '16px',
                            border: `1px solid ${active ? 'rgba(0,229,255,0.5)' : 'rgba(255,255,255,0.08)'}`,
                            background: active ? 'rgba(0,229,255,0.12)' : 'transparent',
                            color: active ? '#00e5ff' : '#9aa3b2',
                            fontSize: '10.5px', fontWeight: 600, cursor: 'pointer',
                          }}
                        >
                          {f === 'all' ? 'Todos' : f === 'groups' ? 'Grupos' : 'Contatos'}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div style={{ position: 'relative', marginBottom: '8px' }}>
                  <Search size={13} color="#6b7384" style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)' }} />
                  <input
                    className="nx-input"
                    placeholder="Buscar contato, grupo, telefone ou setor..."
                    value={recipientSearch}
                    onChange={(e) => setRecipientSearch(e.target.value)}
                    style={{ paddingLeft: '34px' }}
                  />
                </div>
                {selectedRecipients.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px', marginBottom: '8px' }}>
                    {selectedRecipients.map((r) => (
                      <span key={r.id} style={{
                        display: 'inline-flex', alignItems: 'center', gap: '6px',
                        padding: '3px 4px 3px 10px', borderRadius: '16px',
                        background: r.is_group ? 'rgba(16,245,155,0.1)' : 'rgba(0,229,255,0.1)',
                        border: `1px solid ${r.is_group ? 'rgba(16,245,155,0.3)' : 'rgba(0,229,255,0.3)'}`,
                        color: r.is_group ? '#10f59b' : '#00e5ff',
                        fontSize: '11px', fontWeight: 600,
                      }}>
                        {r.is_group && <Users2 size={10} />}
                        {r.name}
                        <button
                          type="button"
                          onClick={() => toggleRecipient(r.id)}
                          style={{ background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', display: 'flex', padding: '2px' }}
                          aria-label={`Remover ${r.name}`}
                        >
                          <X size={11} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <div style={{
                  border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px',
                  maxHeight: '240px', overflowY: 'auto', background: 'rgba(0,0,0,0.2)',
                }}>
                  {contacts.length === 0 ? (
                    <div style={{ padding: '20px', color: '#6b7384', fontSize: '12.5px', textAlign: 'center' }}>
                      Nenhum contato cadastrado. Importe do WhatsApp em "Contatos".
                    </div>
                  ) : filteredContactList.length === 0 ? (
                    <div style={{ padding: '20px', color: '#6b7384', fontSize: '12.5px', textAlign: 'center' }}>
                      Nenhum resultado para "{recipientSearch}".
                    </div>
                  ) : (
                    filteredContactList.map((c, idx) => {
                      const selected = draft.recipient_ids.includes(c.id);
                      return (
                        <div
                          key={c.id}
                          onClick={() => toggleRecipient(c.id)}
                          style={{
                            display: 'flex', alignItems: 'center', gap: '12px',
                            padding: '10px 14px',
                            borderTop: idx === 0 ? 'none' : '1px solid rgba(255,255,255,0.04)',
                            cursor: 'pointer',
                            background: selected ? 'rgba(0,229,255,0.06)' : 'transparent',
                          }}
                        >
                          <span style={{
                            width: '18px', height: '18px', borderRadius: '5px',
                            border: `1px solid ${selected ? '#00e5ff' : 'rgba(255,255,255,0.2)'}`,
                            background: selected ? '#00e5ff' : 'transparent',
                            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                          }}>
                            {selected && <Check size={12} color="#07080c" strokeWidth={3} />}
                          </span>
                          <div style={{
                            width: '32px', height: '32px', borderRadius: '50%',
                            background: c.is_group
                              ? 'linear-gradient(135deg, rgba(16,245,155,0.2), rgba(0,229,255,0.2))'
                              : 'linear-gradient(135deg, rgba(0,229,255,0.2), rgba(179,71,255,0.2))',
                            border: `1px solid ${c.is_group ? 'rgba(16,245,155,0.3)' : 'rgba(0,229,255,0.3)'}`,
                            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                            color: c.is_group ? '#10f59b' : '#00e5ff', fontWeight: 700, fontSize: '12px',
                          }}>
                            {c.is_group ? <Users2 size={13} /> : c.name.charAt(0).toUpperCase()}
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: '13px', fontWeight: 600, color: '#f4f6fb', display: 'flex', alignItems: 'center', gap: '6px' }}>
                              {c.name}
                              {c.is_group && (
                                <span style={{ fontSize: '9px', color: '#10f59b', fontWeight: 700, padding: '1px 5px', borderRadius: '4px', background: 'rgba(16,245,155,0.1)', border: '1px solid rgba(16,245,155,0.3)' }}>GRUPO</span>
                              )}
                            </div>
                            <div style={{ fontSize: '11px', color: '#6b7384', fontFamily: 'monospace' }}>
                              {c.is_group ? (c.remote_jid ?? '') : (c.phone || '—')}
                              {!c.is_group && c.department && <span style={{ fontFamily: 'inherit', color: '#9aa3b2' }}> · {c.department}</span>}
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
                <div style={{ fontSize: '11px', color: '#6b7384', marginTop: '6px' }}>
                  Uma tarefa será criada para cada destinatário selecionado.
                </div>
              </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>
                <Field label="Status">
                  <select
                    className="nx-input"
                    value={draft.status}
                    onChange={(e) => setDraft({ ...draft, status: e.target.value as TaskStatus })}
                  >
                    {TASK_COLUMNS.map((c) => (
                      <option key={c.id} value={c.id} style={{ background: '#0e1016' }}>{c.label}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Prioridade">
                  <select
                    className="nx-input"
                    value={draft.priority}
                    onChange={(e) => setDraft({ ...draft, priority: e.target.value as TaskPriority })}
                  >
                    <option value="high" style={{ background: '#0e1016' }}>Alta</option>
                    <option value="medium" style={{ background: '#0e1016' }}>Média</option>
                    <option value="low" style={{ background: '#0e1016' }}>Baixa</option>
                  </select>
                </Field>
                <Field label="Prazo">
                  <input
                    type="date"
                    className="nx-input"
                    value={draft.due_date}
                    onChange={(e) => setDraft({ ...draft, due_date: e.target.value })}
                  />
                </Field>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: draft.recurrence === 'weekly' || draft.recurrence === 'monthly' || draft.recurrence === 'daily' ? '2fr 1fr' : '1fr', gap: '12px' }}>
                <Field label="Recorrência" hint="Ao marcar como concluída, a tarefa reabre automaticamente no próximo ciclo.">
                  <select
                    className="nx-input"
                    value={draft.recurrence}
                    onChange={(e) => setDraft({ ...draft, recurrence: e.target.value as TaskRecurrence })}
                  >
                    {RECURRENCE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value} style={{ background: '#0e1016' }}>{o.label} — {o.hint}</option>
                    ))}
                  </select>
                </Field>
                {(draft.recurrence === 'daily' || draft.recurrence === 'weekly' || draft.recurrence === 'monthly') && (
                  <Field label="A cada" hint={draft.recurrence === 'daily' ? 'dia(s)' : draft.recurrence === 'weekly' ? 'semana(s)' : 'mês(es)'}>
                    <input
                      type="number"
                      min={1}
                      max={30}
                      className="nx-input"
                      value={draft.recurrence_interval}
                      onChange={(e) => setDraft({ ...draft, recurrence_interval: Math.max(1, parseInt(e.target.value || '1', 10)) })}
                    />
                  </Field>
                )}
              </div>

              <div style={{
                border: '1px solid rgba(0,229,255,0.18)',
                borderRadius: '12px',
                padding: '14px 16px',
                background: 'rgba(0,229,255,0.04)',
                display: 'flex', flexDirection: 'column', gap: '12px',
              }}>
                <div style={{ fontSize: '11px', color: '#00e5ff', fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase' }}>
                  Cobrança automática (GIA)
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: '12px' }}>
                  <Field label="Primeira cobrança" hint="Data e horário do primeiro envio. Deixe em branco para não cobrar automaticamente.">
                    <input
                      type="datetime-local"
                      className="nx-input"
                      value={draft.first_nudge_at}
                      onChange={(e) => setDraft({ ...draft, first_nudge_at: e.target.value })}
                    />
                  </Field>
                  <Field label="Repetir a cada" hint={draft.nudge_repeat_hours === 0 ? 'Envio único' : `${draft.nudge_repeat_hours}h enquanto pendente`}>
                    <select
                      className="nx-input"
                      value={draft.nudge_repeat_hours}
                      onChange={(e) => setDraft({ ...draft, nudge_repeat_hours: parseInt(e.target.value, 10) })}
                    >
                      <option value={0} style={{ background: '#0e1016' }}>Envio único</option>
                      <option value={1} style={{ background: '#0e1016' }}>1 hora</option>
                      <option value={2} style={{ background: '#0e1016' }}>2 horas</option>
                      <option value={3} style={{ background: '#0e1016' }}>3 horas</option>
                      <option value={6} style={{ background: '#0e1016' }}>6 horas</option>
                      <option value={12} style={{ background: '#0e1016' }}>12 horas</option>
                      <option value={24} style={{ background: '#0e1016' }}>1 dia</option>
                      <option value={48} style={{ background: '#0e1016' }}>2 dias</option>
                      <option value={72} style={{ background: '#0e1016' }}>3 dias</option>
                      <option value={168} style={{ background: '#0e1016' }}>1 semana</option>
                    </select>
                  </Field>
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '24px' }}>
              <button onClick={() => setModalOpen(false)} className="ghost-btn">Cancelar</button>
              <button
                onClick={saveTask}
                className="neon-btn"
                disabled={saving || !draft.title.trim() || (!editingId && draft.recipient_ids.length === 0)}
              >
                {saving
                  ? 'Salvando...'
                  : editingId
                  ? 'Salvar Alterações'
                  : draft.recipient_ids.length > 1
                  ? `Criar ${draft.recipient_ids.length} Tarefas`
                  : 'Criar Tarefa'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <span style={{ fontSize: '11px', color: '#9aa3b2', fontWeight: 600, letterSpacing: '0.4px', textTransform: 'uppercase' }}>{label}</span>
      {children}
      {hint && <span style={{ fontSize: '11px', color: '#6b7384' }}>{hint}</span>}
    </label>
  );
}
