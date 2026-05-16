import { useEffect, useState } from 'react';
import { Plus, CreditCard as Edit, Trash2, Search, X, Send, Clock, Zap, Copy } from 'lucide-react';
import { supabase } from '../lib/supabase';
import type { Schedule, MessageTemplate, Contact } from '../lib/types';
import { DAYS_OF_WEEK } from '../lib/types';

interface ScheduleForm {
  name: string;
  template_id: string;
  send_time: string;
  days_of_week: number[];
  contact_ids: string[] | null;
  send_once: boolean;
}

const emptyForm: ScheduleForm = {
  name: '',
  template_id: '',
  send_time: '09:00',
  days_of_week: [1, 2, 3, 4, 5],
  contact_ids: null,
  send_once: false,
};

export function Scheduling() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editSchedule, setEditSchedule] = useState<Schedule | null>(null);
  const [form, setForm] = useState<ScheduleForm>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [contactSearch, setContactSearch] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Schedule | null>(null);
  const [sendOnceTarget, setSendOnceTarget] = useState<Schedule | null>(null);
  const [sendingOnce, setSendingOnce] = useState(false);
  const [copied, setCopied] = useState(false);

  const cronUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/send-scheduled-messages`;

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    setLoading(true);
    const [{ data: schedulesData }, { data: templatesData }, { data: contactsData }] = await Promise.all([
      supabase.from('schedules').select('*, message_templates(id,name)').order('created_at', { ascending: false }),
      supabase.from('message_templates').select('id, name').eq('active', true),
      supabase.from('contacts').select('id, name, phone').eq('active', true).order('name'),
    ]);
    setSchedules((schedulesData as Schedule[]) ?? []);
    setTemplates((templatesData as MessageTemplate[]) ?? []);
    setContacts((contactsData as Contact[]) ?? []);
    setLoading(false);
  }

  function openCreate() {
    setEditSchedule(null); setForm(emptyForm); setError(''); setContactSearch(''); setModalOpen(true);
  }

  function openEdit(s: Schedule) {
    setEditSchedule(s);
    setForm({
      name: s.name,
      template_id: s.template_id ?? '',
      send_time: s.send_time,
      days_of_week: [...s.days_of_week],
      contact_ids: s.contact_ids ? [...s.contact_ids] : null,
      send_once: s.send_once,
    });
    setError(''); setContactSearch(''); setModalOpen(true);
  }

  function toggleDay(day: number) {
    setForm((prev) => {
      const has = prev.days_of_week.includes(day);
      return { ...prev, days_of_week: has ? prev.days_of_week.filter((d) => d !== day) : [...prev.days_of_week, day].sort((a, b) => a - b) };
    });
  }

  function toggleContact(id: string) {
    setForm((prev) => {
      const current = prev.contact_ids ?? [];
      const has = current.includes(id);
      const updated = has ? current.filter((c) => c !== id) : [...current, id];
      return { ...prev, contact_ids: updated.length === 0 ? null : updated };
    });
  }

  function toggleAllContacts() {
    setForm((prev) => {
      const allSelected = prev.contact_ids === null || prev.contact_ids.length === contacts.length;
      return { ...prev, contact_ids: allSelected ? [] : null };
    });
  }

  async function handleSave() {
    setError('');
    if (!form.name.trim()) { setError('O nome do agendamento é obrigatório.'); return; }
    if (!form.template_id) { setError('Selecione um template de mensagem.'); return; }
    if (!form.send_once && form.days_of_week.length === 0) { setError('Selecione pelo menos um dia da semana.'); return; }
    if (!form.send_once && !form.send_time) { setError('Defina um horário de envio.'); return; }
    setSaving(true);
    const payload = {
      name: form.name.trim(), template_id: form.template_id, send_time: form.send_time,
      days_of_week: form.days_of_week, contact_ids: form.contact_ids, send_once: form.send_once,
      updated_at: new Date().toISOString(),
    };
    try {
      if (editSchedule) await supabase.from('schedules').update(payload).eq('id', editSchedule.id);
      else await supabase.from('schedules').insert(payload);
      setModalOpen(false);
      await loadData();
    } catch {
      setError('Erro ao salvar agendamento.');
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleActive(schedule: Schedule) {
    await supabase.from('schedules').update({ active: !schedule.active, updated_at: new Date().toISOString() }).eq('id', schedule.id);
    await loadData();
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    await supabase.from('schedules').delete().eq('id', deleteTarget.id);
    setDeleteTarget(null);
    await loadData();
  }

  async function confirmSendOnce() {
    if (!sendOnceTarget) return;
    setSendingOnce(true);
    try {
      await fetch(cronUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}` },
        body: JSON.stringify({ force_schedule_id: sendOnceTarget.id }),
      });
    } finally {
      setSendingOnce(false);
      setSendOnceTarget(null);
    }
  }

  function copyUrl() {
    navigator.clipboard.writeText(cronUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const contactsAllSelected = form.contact_ids === null || form.contact_ids.length === contacts.length;
  const filteredContacts = contacts.filter((c) =>
    contactSearch.trim() === '' ? true : c.name.toLowerCase().includes(contactSearch.toLowerCase()) || c.phone.includes(contactSearch)
  );

  return (
    <div className="page-container" style={{ maxWidth: '1400px' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '24px', flexWrap: 'wrap', gap: '16px' }}>
        <div>
          <div style={{ fontSize: '11px', color: '#6b7384', letterSpacing: '2px', textTransform: 'uppercase', fontWeight: 600, marginBottom: '6px' }}>
            Automação
          </div>
          <h1 className="page-title" style={{ fontSize: '32px', fontWeight: 700, color: '#f4f6fb', margin: 0, letterSpacing: '-0.5px' }}>
            Agendamentos
          </h1>
          <p style={{ color: '#9aa3b2', margin: '6px 0 0', fontSize: '14px' }}>
            Envios recorrentes e pontuais com horário e dias da semana.
          </p>
        </div>
        <button className="neon-btn" onClick={openCreate}>
          <Plus size={14} /> Novo Agendamento
        </button>
      </header>

      <div className="glass" style={{ padding: '18px 20px', marginBottom: '20px', display: 'flex', gap: '14px', alignItems: 'flex-start' }}>
        <div style={{
          width: '40px', height: '40px', borderRadius: '10px',
          background: 'rgba(0,229,255,0.12)', border: '1px solid rgba(0,229,255,0.35)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <Zap size={18} color="#00e5ff" />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '13.5px', fontWeight: 600, color: '#f4f6fb' }}>
            Disparo automático via cron-job.org
          </div>
          <div style={{ fontSize: '12px', color: '#9aa3b2', marginTop: '3px', lineHeight: 1.55 }}>
            Configure um cron-job externo para chamar a URL abaixo a cada minuto. A função verifica agendamentos ativos e envia pela Evolution API.
          </div>
          <div style={{
            marginTop: '10px', display: 'flex', alignItems: 'center', gap: '8px',
            background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(0,229,255,0.25)',
            borderRadius: '8px', padding: '10px 12px',
          }}>
            <code style={{ flex: 1, fontFamily: 'monospace', fontSize: '11.5px', color: '#00e5ff', wordBreak: 'break-all' }}>
              {cronUrl}
            </code>
            <button onClick={copyUrl} className="ghost-btn" style={{ padding: '4px 10px', fontSize: '11px' }}>
              <Copy size={12} /> {copied ? 'Copiado!' : 'Copiar'}
            </button>
          </div>
          <div style={{ fontSize: '11px', color: '#6b7384', marginTop: '6px' }}>
            Frequência: a cada 1 minuto — Método: GET ou POST
          </div>
        </div>
      </div>

      {loading ? (
        <div className="glass" style={{ padding: '60px', textAlign: 'center', color: '#6b7384' }}>Carregando...</div>
      ) : schedules.length === 0 ? (
        <div className="glass" style={{ padding: '80px', textAlign: 'center', color: '#6b7384', fontSize: '13px' }}>
          Nenhum agendamento configurado. Crie seu primeiro envio recorrente.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {schedules.map((sched) => (
            <div key={sched.id} className="glass" style={{
              padding: '18px 20px', display: 'flex', alignItems: 'center', gap: '18px',
              opacity: sched.active || sched.send_once ? 1 : 0.55, flexWrap: 'wrap',
            }}>
              <div style={{
                fontSize: '20px', fontWeight: 700, fontFamily: 'monospace',
                color: sched.send_once ? '#ffb547' : sched.active ? '#00e5ff' : '#6b7384',
                minWidth: '64px', textShadow: sched.active && !sched.send_once ? '0 0 12px rgba(0,229,255,0.4)' : 'none',
              }}>
                {sched.send_once ? 'ÚNICO' : sched.send_time}
              </div>
              <div style={{ width: '1px', height: '44px', background: 'rgba(255,255,255,0.08)' }} />
              <div style={{ flex: 1, minWidth: '200px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '5px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '15px', fontWeight: 600, color: '#f4f6fb' }}>{sched.name}</span>
                  {sched.send_once && (
                    <span className="chip" style={{ background: 'rgba(255,181,71,0.12)', color: '#ffb547', border: '1px solid rgba(255,181,71,0.35)' }}>
                      Envio Único
                    </span>
                  )}
                </div>
                <div style={{ fontSize: '12px', color: '#9aa3b2', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                  <span>Template: <strong style={{ color: '#c6cdda' }}>{(sched.message_templates as any)?.name ?? 'Removido'}</strong></span>
                  <span style={{ color: '#3a3f4a' }}>|</span>
                  <span>Contatos: <strong style={{ color: '#c6cdda' }}>{sched.contact_ids === null ? 'Todos' : `${sched.contact_ids.length}`}</strong></span>
                  {!sched.send_once && (
                    <>
                      <span style={{ color: '#3a3f4a' }}>|</span>
                      <div style={{ display: 'flex', gap: '4px' }}>
                        {DAYS_OF_WEEK.map((day) => {
                          const on = sched.days_of_week.includes(day.value);
                          return (
                            <span key={day.value} style={{
                              fontSize: '10.5px', fontWeight: 600,
                              padding: '2px 6px', borderRadius: '4px',
                              background: on ? 'rgba(0,229,255,0.12)' : 'rgba(255,255,255,0.04)',
                              color: on ? '#00e5ff' : '#6b7384',
                              border: `1px solid ${on ? 'rgba(0,229,255,0.3)' : 'rgba(255,255,255,0.06)'}`,
                            }}>
                              {day.label}
                            </span>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                {sched.send_once && (
                  <button className="ghost-btn" onClick={() => setSendOnceTarget(sched)}>
                    <Send size={13} /> Disparar
                  </button>
                )}
                {!sched.send_once && (
                  <label className={`toggle ${sched.active ? 'on' : ''}`} style={{ cursor: 'pointer' }}>
                    <input type="checkbox" checked={sched.active} onChange={() => handleToggleActive(sched)} style={{ display: 'none' }} />
                    <span className="toggle-knob" />
                  </label>
                )}
                <button className="ghost-btn" onClick={() => openEdit(sched)} aria-label="Editar" style={{ padding: '6px 8px' }}>
                  <Edit size={13} />
                </button>
                <button className="ghost-btn" onClick={() => setDeleteTarget(sched)} aria-label="Excluir" style={{ padding: '6px 8px', color: '#ff4d79' }}>
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {modalOpen && (
        <Modal onClose={() => setModalOpen(false)} title={editSchedule ? 'Editar Agendamento' : 'Novo Agendamento'} width={600}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {error && (
              <div style={{
                padding: '10px 14px', borderRadius: '10px',
                background: 'rgba(255,77,121,0.08)', border: '1px solid rgba(255,77,121,0.35)',
                color: '#ff4d79', fontSize: '12.5px',
              }}>{error}</div>
            )}

            <Field label="Nome do Agendamento">
              <input
                className="nx-input"
                placeholder="Ex: Cobrança Relatório - Time Comercial"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </Field>

            <Field label="Template de Mensagem">
              <select
                className="nx-input"
                value={form.template_id}
                onChange={(e) => setForm({ ...form, template_id: e.target.value })}
              >
                <option value="" style={{ background: '#0e1016' }}>-- Selecione um template --</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id} style={{ background: '#0e1016' }}>{t.name}</option>
                ))}
              </select>
            </Field>

            <div>
              <div style={{ fontSize: '11px', color: '#9aa3b2', fontWeight: 600, letterSpacing: '0.4px', textTransform: 'uppercase', marginBottom: '8px' }}>
                Modo de Envio
              </div>
              <div style={{ display: 'flex', gap: '10px' }}>
                <ModeCard
                  active={!form.send_once}
                  onClick={() => setForm({ ...form, send_once: false })}
                  title="Recorrente"
                  description="Dispara nos dias e horário definidos."
                  color="#00e5ff"
                />
                <ModeCard
                  active={form.send_once}
                  onClick={() => setForm({ ...form, send_once: true })}
                  title="Envio Único"
                  description="Dispara manualmente ao clicar em Disparar."
                  color="#ffb547"
                />
              </div>
            </div>

            {!form.send_once && (
              <>
                <Field label="Horário de Envio">
                  <input
                    type="time"
                    className="nx-input"
                    value={form.send_time}
                    onChange={(e) => setForm({ ...form, send_time: e.target.value })}
                    style={{ width: '160px' }}
                  />
                </Field>
                <div>
                  <div style={{ fontSize: '11px', color: '#9aa3b2', fontWeight: 600, letterSpacing: '0.4px', textTransform: 'uppercase', marginBottom: '8px' }}>
                    Dias da Semana
                  </div>
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    {DAYS_OF_WEEK.map((day) => {
                      const selected = form.days_of_week.includes(day.value);
                      return (
                        <button
                          key={day.value}
                          onClick={() => toggleDay(day.value)}
                          style={{
                            width: '44px', height: '44px', borderRadius: '10px',
                            border: `1px solid ${selected ? 'rgba(0,229,255,0.5)' : 'rgba(255,255,255,0.08)'}`,
                            background: selected ? 'rgba(0,229,255,0.12)' : 'rgba(255,255,255,0.02)',
                            color: selected ? '#00e5ff' : '#9aa3b2',
                            fontSize: '12px', fontWeight: 600, cursor: 'pointer', transition: 'all 0.15s',
                          }}
                        >
                          {day.label}
                        </button>
                      );
                    })}
                  </div>
                  {form.days_of_week.length === 0 && (
                    <div style={{ fontSize: '11px', color: '#ff4d79', marginTop: '6px' }}>Selecione pelo menos um dia.</div>
                  )}
                </div>
              </>
            )}

            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                <span style={{ fontSize: '11px', color: '#9aa3b2', fontWeight: 600, letterSpacing: '0.4px', textTransform: 'uppercase' }}>
                  Contatos
                </span>
                <button
                  onClick={toggleAllContacts}
                  style={{ fontSize: '11px', color: '#00e5ff', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}
                >
                  {contactsAllSelected ? 'Desmarcar todos' : 'Selecionar todos'}
                </button>
              </div>
              <div style={{ position: 'relative', marginBottom: '8px' }}>
                <Search size={13} color="#6b7384" style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)' }} />
                <input
                  className="nx-input"
                  placeholder="Buscar por nome ou telefone..."
                  value={contactSearch}
                  onChange={(e) => setContactSearch(e.target.value)}
                  style={{ paddingLeft: '34px' }}
                />
              </div>
              <div style={{
                border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px',
                maxHeight: '220px', overflowY: 'auto', background: 'rgba(0,0,0,0.2)',
              }}>
                {contacts.length === 0 ? (
                  <div style={{ padding: '14px', color: '#6b7384', fontSize: '12.5px' }}>Nenhum contato ativo.</div>
                ) : filteredContacts.length === 0 ? (
                  <div style={{ padding: '14px', color: '#6b7384', fontSize: '12.5px' }}>Nenhum contato encontrado para "{contactSearch}".</div>
                ) : (
                  filteredContacts.map((c, idx) => {
                    const selected = form.contact_ids === null || form.contact_ids.includes(c.id);
                    return (
                      <div
                        key={c.id}
                        onClick={() => toggleContact(c.id)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: '12px',
                          padding: '10px 14px',
                          borderTop: idx === 0 ? 'none' : '1px solid rgba(255,255,255,0.04)',
                          cursor: 'pointer',
                          background: selected ? 'rgba(0,229,255,0.05)' : 'transparent',
                          transition: 'background 0.1s',
                        }}
                      >
                        <span style={{
                          width: '16px', height: '16px', borderRadius: '4px',
                          border: `1px solid ${selected ? '#00e5ff' : 'rgba(255,255,255,0.15)'}`,
                          background: selected ? '#00e5ff' : 'transparent',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                        }}>
                          {selected && <span style={{ color: '#07080c', fontSize: '10px', fontWeight: 700 }}>✓</span>}
                        </span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: '13px', fontWeight: 600, color: '#f4f6fb' }}>{c.name}</div>
                          <div style={{ fontSize: '11px', color: '#6b7384', fontFamily: 'monospace' }}>{c.phone}</div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
              <div style={{ fontSize: '11px', color: '#6b7384', marginTop: '6px' }}>
                {form.contact_ids === null
                  ? 'Todos os contatos ativos receberão a mensagem.'
                  : `${form.contact_ids.length} contato(s) selecionado(s).`}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '22px' }}>
            <button className="ghost-btn" onClick={() => setModalOpen(false)}>Cancelar</button>
            <button className="neon-btn" disabled={saving} onClick={handleSave}>
              {saving ? 'Salvando...' : editSchedule ? 'Salvar Alterações' : 'Criar Agendamento'}
            </button>
          </div>
        </Modal>
      )}

      {deleteTarget && (
        <Modal onClose={() => setDeleteTarget(null)} title="Confirmar Exclusão">
          <p style={{ color: '#c6cdda', fontSize: '13.5px', lineHeight: 1.6, margin: 0 }}>
            Excluir o agendamento <strong style={{ color: '#f4f6fb' }}>{deleteTarget.name}</strong>?
          </p>
          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '22px' }}>
            <button className="ghost-btn" onClick={() => setDeleteTarget(null)}>Cancelar</button>
            <button className="neon-btn" style={{ background: 'linear-gradient(135deg, #ff4d79, #b347ff)' }} onClick={handleDelete}>Excluir</button>
          </div>
        </Modal>
      )}

      {sendOnceTarget && (
        <Modal onClose={() => setSendOnceTarget(null)} title="Confirmar Disparo">
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
            <Clock size={18} color="#ffb547" style={{ flexShrink: 0, marginTop: '2px' }} />
            <p style={{ color: '#c6cdda', fontSize: '13.5px', lineHeight: 1.6, margin: 0 }}>
              Disparar agora o agendamento <strong style={{ color: '#f4f6fb' }}>{sendOnceTarget.name}</strong> para{' '}
              <strong style={{ color: '#00e5ff' }}>
                {sendOnceTarget.contact_ids === null
                  ? 'todos os contatos ativos'
                  : `${sendOnceTarget.contact_ids.length} contato(s) selecionado(s)`}
              </strong>?
            </p>
          </div>
          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '22px' }}>
            <button className="ghost-btn" onClick={() => setSendOnceTarget(null)}>Cancelar</button>
            <button className="neon-btn" disabled={sendingOnce} onClick={confirmSendOnce}>
              <Send size={13} /> {sendingOnce ? 'Disparando...' : 'Disparar Agora'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <span style={{ fontSize: '11px', color: '#9aa3b2', fontWeight: 600, letterSpacing: '0.4px', textTransform: 'uppercase' }}>{label}</span>
      {children}
    </label>
  );
}

function ModeCard({ active, onClick, title, description, color }: { active: boolean; onClick: () => void; title: string; description: string; color: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1, padding: '12px 14px', borderRadius: '10px',
        border: `1px solid ${active ? color + '80' : 'rgba(255,255,255,0.08)'}`,
        background: active ? `${color}14` : 'rgba(255,255,255,0.02)',
        cursor: 'pointer', textAlign: 'left', transition: 'all 0.15s',
      }}
    >
      <div style={{ fontSize: '13px', fontWeight: 600, color: active ? color : '#c6cdda' }}>{title}</div>
      <div style={{ fontSize: '11px', color: '#6b7384', marginTop: '3px' }}>{description}</div>
    </button>
  );
}

function Modal({ title, children, onClose, width = 520 }: { title: string; children: React.ReactNode; onClose: () => void; width?: number }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(4,5,9,0.75)', backdropFilter: 'blur(6px)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
      <div onClick={(e) => e.stopPropagation()} className="glass" style={{ width: '100%', maxWidth: `${width}px`, padding: '26px', maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '18px' }}>
          <h2 style={{ fontSize: '18px', fontWeight: 700, color: '#f4f6fb', margin: 0 }}>{title}</h2>
          <button onClick={onClose} className="ghost-btn" style={{ padding: '6px' }}><X size={15} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}
