import { useEffect, useState } from 'react';
import { RefreshCw, Info, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import type { SendLog } from '../lib/types';

const STATUS_LABEL: Record<string, string> = { sent: 'Enviado', error: 'Erro', pending: 'Pendente' };

function statusColors(status: string) {
  if (status === 'sent') return { bg: 'rgba(16,245,155,0.12)', fg: '#10f59b', border: 'rgba(16,245,155,0.3)', dot: '#10f59b' };
  if (status === 'error') return { bg: 'rgba(255,77,121,0.12)', fg: '#ff4d79', border: 'rgba(255,77,121,0.3)', dot: '#ff4d79' };
  return { bg: 'rgba(255,181,71,0.12)', fg: '#ffb547', border: 'rgba(255,181,71,0.3)', dot: '#ffb547' };
}

interface WebhookEvent {
  id: string;
  received_at: string;
  event: string;
  from_me: boolean;
  remote_jid: string;
  text: string;
  outcome: string;
  notes: string;
}

export function Logs() {
  const [tab, setTab] = useState<'sent' | 'webhook'>('sent');
  const [logs, setLogs] = useState<SendLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('all');
  const [selectedLog, setSelectedLog] = useState<SendLog | null>(null);
  const [page, setPage] = useState(0);
  const [webhookEvents, setWebhookEvents] = useState<WebhookEvent[]>([]);
  const PAGE_SIZE = 20;

  useEffect(() => { loadLogs(); }, [statusFilter, page]);
  useEffect(() => { if (tab === 'webhook') loadWebhookEvents(); }, [tab]);

  async function loadWebhookEvents() {
    setLoading(true);
    const { data } = await supabase
      .from('webhook_events')
      .select('id, received_at, event, from_me, remote_jid, text, outcome, notes')
      .order('received_at', { ascending: false })
      .limit(50);
    setWebhookEvents((data as WebhookEvent[]) ?? []);
    setLoading(false);
  }

  async function loadLogs() {
    setLoading(true);
    let query = supabase
      .from('send_logs')
      .select('*', { count: 'exact' })
      .order('sent_at', { ascending: false })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
    if (statusFilter !== 'all') query = query.eq('status', statusFilter);
    const { data } = await query;
    setLogs((data as SendLog[]) ?? []);
    setLoading(false);
  }

  return (
    <div style={{ padding: '32px 36px', maxWidth: '1400px', margin: '0 auto' }}>
      <header style={{ marginBottom: '24px' }}>
        <div style={{ fontSize: '11px', color: '#6b7384', letterSpacing: '2px', textTransform: 'uppercase', fontWeight: 600, marginBottom: '6px' }}>
          Histórico
        </div>
        <h1 style={{ fontSize: '32px', fontWeight: 700, color: '#f4f6fb', margin: 0, letterSpacing: '-0.5px' }}>
          Logs de Envio
        </h1>
        <p style={{ color: '#9aa3b2', margin: '6px 0 0', fontSize: '14px' }}>
          Todas as mensagens enviadas via Evolution API.
        </p>
      </header>

      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' }}>
        {([
          { key: 'sent', label: 'Mensagens Enviadas' },
          { key: 'webhook', label: 'Webhook (entrada)' },
        ] as const).map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              style={{
                padding: '8px 16px', borderRadius: '20px',
                border: `1px solid ${active ? 'rgba(0,229,255,0.5)' : 'rgba(255,255,255,0.08)'}`,
                background: active ? 'rgba(0,229,255,0.12)' : 'transparent',
                color: active ? '#00e5ff' : '#9aa3b2',
                fontSize: '12.5px', fontWeight: 600, cursor: 'pointer',
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {tab === 'webhook' ? (
        <div className="glass" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{ fontSize: '12px', color: '#9aa3b2' }}>
              Últimos 50 eventos recebidos no webhook. Se estiver vazio, a Evolution não está chamando a URL.
            </div>
            <button className="ghost-btn" onClick={loadWebhookEvents}>
              <RefreshCw size={13} /> Atualizar
            </button>
          </div>
          {loading ? (
            <div style={{ padding: '60px', textAlign: 'center', color: '#6b7384' }}>Carregando...</div>
          ) : webhookEvents.length === 0 ? (
            <div style={{ padding: '60px', textAlign: 'center', color: '#6b7384', fontSize: '13px' }}>
              Nenhum evento recebido. A Evolution ainda não disparou nada para esta URL.
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'rgba(255,255,255,0.03)' }}>
                    {['Recebido em', 'Evento', 'De', 'Texto', 'Resultado', 'Notas'].map((c) => (
                      <th key={c} style={{ padding: '12px 16px', textAlign: 'left', fontSize: '11px', color: '#6b7384', fontWeight: 600, letterSpacing: '0.6px', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {webhookEvents.map((ev) => (
                    <tr key={ev.id} style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                      <td style={{ padding: '12px 16px', fontSize: '11.5px', color: '#9aa3b2', whiteSpace: 'nowrap' }}>
                        {new Date(ev.received_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </td>
                      <td style={{ padding: '12px 16px', fontSize: '12px', color: '#c6cdda', fontFamily: 'monospace' }}>{ev.event || '—'}</td>
                      <td style={{ padding: '12px 16px', fontSize: '11.5px', color: ev.from_me ? '#6b7384' : '#f4f6fb', fontFamily: 'monospace' }}>
                        {ev.from_me ? '(eu)' : (ev.remote_jid || '—')}
                      </td>
                      <td style={{ padding: '12px 16px', fontSize: '12px', color: '#f4f6fb', maxWidth: '240px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ev.text || '—'}</td>
                      <td style={{ padding: '12px 16px', fontSize: '11.5px' }}>
                        <span className="chip" style={{
                          background: ev.outcome.startsWith('matched') ? 'rgba(16,245,155,0.12)' : ev.outcome === 'error' ? 'rgba(255,77,121,0.12)' : 'rgba(255,255,255,0.05)',
                          color: ev.outcome.startsWith('matched') ? '#10f59b' : ev.outcome === 'error' ? '#ff4d79' : '#9aa3b2',
                          border: '1px solid rgba(255,255,255,0.08)',
                        }}>{ev.outcome || '—'}</span>
                      </td>
                      <td style={{ padding: '12px 16px', fontSize: '11.5px', color: '#9aa3b2', maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ev.notes || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
      <div className="glass" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', gap: '16px', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.06)', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {(['all', 'sent', 'error', 'pending'] as const).map((s) => {
              const active = statusFilter === s;
              return (
                <button
                  key={s}
                  onClick={() => { setStatusFilter(s); setPage(0); }}
                  style={{
                    padding: '6px 14px', borderRadius: '20px',
                    border: `1px solid ${active ? 'rgba(0,229,255,0.5)' : 'rgba(255,255,255,0.08)'}`,
                    background: active ? 'rgba(0,229,255,0.12)' : 'transparent',
                    color: active ? '#00e5ff' : '#9aa3b2',
                    fontSize: '12px', fontWeight: 600, cursor: 'pointer', transition: 'all 0.15s',
                  }}
                >
                  {s === 'all' ? 'Todos' : STATUS_LABEL[s]}
                </button>
              );
            })}
          </div>
          <button className="ghost-btn" onClick={() => loadLogs()}>
            <RefreshCw size={13} /> Atualizar
          </button>
        </div>

        {loading ? (
          <div style={{ padding: '60px', textAlign: 'center', color: '#6b7384' }}>Carregando...</div>
        ) : logs.length === 0 ? (
          <div style={{ padding: '60px', textAlign: 'center', color: '#6b7384', fontSize: '13px' }}>
            Nenhum log encontrado para o filtro selecionado.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'rgba(255,255,255,0.03)' }}>
                  {['Contato', 'Telefone', 'Template', 'Status', 'Enviado em', 'Ações'].map((col) => (
                    <th key={col} style={{ padding: '12px 16px', textAlign: 'left', fontSize: '11px', color: '#6b7384', fontWeight: 600, letterSpacing: '0.6px', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{col}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => {
                  const c = statusColors(log.status);
                  return (
                    <tr key={log.id} style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                      <td style={{ padding: '13px 16px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                          <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: c.dot, flexShrink: 0, boxShadow: `0 0 8px ${c.dot}` }} />
                          <span style={{ fontSize: '13px', fontWeight: 500, color: '#f4f6fb' }}>{log.contact_name || '—'}</span>
                        </div>
                      </td>
                      <td style={{ padding: '13px 16px', fontSize: '12px', color: '#c6cdda', fontFamily: 'monospace' }}>{log.contact_phone || '—'}</td>
                      <td style={{ padding: '13px 16px', fontSize: '12.5px', color: '#9aa3b2' }}>{log.template_name || '—'}</td>
                      <td style={{ padding: '13px 16px' }}>
                        <span className="chip" style={{ background: c.bg, color: c.fg, border: `1px solid ${c.border}` }}>
                          {STATUS_LABEL[log.status] ?? log.status}
                        </span>
                      </td>
                      <td style={{ padding: '13px 16px', fontSize: '11.5px', color: '#6b7384', whiteSpace: 'nowrap' }}>
                        {new Date(log.sent_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </td>
                      <td style={{ padding: '13px 16px' }}>
                        <button className="ghost-btn" onClick={() => setSelectedLog(log)} aria-label="Detalhes" style={{ padding: '6px 8px' }}>
                          <Info size={13} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {!loading && logs.length > 0 && (
          <div style={{ padding: '12px 18px', display: 'flex', justifyContent: 'flex-end', gap: '8px', alignItems: 'center', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
            <button className="ghost-btn" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))} style={{ padding: '6px 8px' }} aria-label="Anterior">
              <ChevronLeft size={14} />
            </button>
            <span style={{ fontSize: '12px', color: '#9aa3b2', padding: '0 8px' }}>Página {page + 1}</span>
            <button className="ghost-btn" disabled={logs.length < PAGE_SIZE} onClick={() => setPage((p) => p + 1)} style={{ padding: '6px 8px' }} aria-label="Próxima">
              <ChevronRight size={14} />
            </button>
          </div>
        )}
      </div>
      )}

      {selectedLog && (
        <Modal onClose={() => setSelectedLog(null)} title="Detalhes do Envio">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <DetailField label="Contato" value={selectedLog.contact_name || '—'} />
              <DetailField label="Telefone" value={selectedLog.contact_phone || '—'} mono />
              <DetailField label="Template" value={selectedLog.template_name || '—'} />
              <div>
                <FieldLabel>Status</FieldLabel>
                {(() => {
                  const c = statusColors(selectedLog.status);
                  return (
                    <span className="chip" style={{ background: c.bg, color: c.fg, border: `1px solid ${c.border}`, marginTop: '4px', display: 'inline-block' }}>
                      {STATUS_LABEL[selectedLog.status] ?? selectedLog.status}
                    </span>
                  );
                })()}
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <FieldLabel>Enviado em</FieldLabel>
                <div style={{ fontSize: '13px', color: '#c6cdda', marginTop: '4px' }}>
                  {new Date(selectedLog.sent_at).toLocaleString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </div>
              </div>
            </div>
            {selectedLog.message_content && (
              <div>
                <FieldLabel>Mensagem Enviada</FieldLabel>
                <div style={{
                  marginTop: '6px',
                  background: 'rgba(16,245,155,0.06)',
                  border: '1px solid rgba(16,245,155,0.2)',
                  borderRadius: '10px 10px 2px 10px',
                  padding: '12px 14px', fontSize: '13px', lineHeight: 1.6,
                  color: '#e4f6ec', whiteSpace: 'pre-wrap', maxWidth: '380px', marginLeft: 'auto',
                }}>
                  {selectedLog.message_content}
                </div>
              </div>
            )}
            {selectedLog.error_message && (
              <div style={{
                background: 'rgba(255,77,121,0.08)', border: '1px solid rgba(255,77,121,0.35)',
                borderRadius: '10px', padding: '10px 14px', fontSize: '12.5px', color: '#ff4d79',
              }}>
                <strong>Erro:</strong> {selectedLog.error_message}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '22px' }}>
            <button className="ghost-btn" onClick={() => setSelectedLog(null)}>Fechar</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <span style={{ fontSize: '11px', color: '#6b7384', fontWeight: 600, letterSpacing: '0.4px', textTransform: 'uppercase' }}>{children}</span>;
}

function DetailField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <div style={{ fontSize: '13px', color: '#f4f6fb', fontWeight: 500, marginTop: '4px', fontFamily: mono ? 'monospace' : 'inherit' }}>{value}</div>
    </div>
  );
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(4,5,9,0.75)', backdropFilter: 'blur(6px)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
      <div onClick={(e) => e.stopPropagation()} className="glass" style={{ width: '100%', maxWidth: '560px', padding: '26px', maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '18px' }}>
          <h2 style={{ fontSize: '18px', fontWeight: 700, color: '#f4f6fb', margin: 0 }}>{title}</h2>
          <button onClick={onClose} className="ghost-btn" style={{ padding: '6px' }}><X size={15} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}
