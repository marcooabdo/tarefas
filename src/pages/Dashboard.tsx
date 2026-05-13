import { useEffect, useMemo, useState } from 'react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  AreaChart,
  Area,
} from 'recharts';
import { CircleCheck as CheckCircle2, TriangleAlert as AlertTriangle, Bot, Target, MessageSquare, WifiOff, Wifi } from 'lucide-react';
import { supabase } from '../lib/supabase';
import type { Task, SendLog } from '../lib/types';

interface KPI {
  label: string;
  value: string;
  hint: string;
  Icon: typeof CheckCircle2;
  glow: string;
  accent: string;
}

function formatRelative(iso: string) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s atrás`;
  if (diff < 3600) return `${Math.floor(diff / 60)}min atrás`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h atrás`;
  return `${Math.floor(diff / 86400)}d atrás`;
}

interface WhatsStatus {
  connected: boolean;
  reason?: string;
  state?: string;
}

export function Dashboard() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [logs, setLogs] = useState<SendLog[]>([]);
  const [whats, setWhats] = useState<WhatsStatus | null>(null);

  useEffect(() => {
    loadData();
    checkWhats();
    const id = setInterval(() => { loadData(); checkWhats(); }, 15000);
    return () => clearInterval(id);
  }, []);

  async function checkWhats() {
    try {
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/check-whatsapp-status`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}` },
      });
      setWhats(await res.json());
    } catch {
      setWhats({ connected: false, reason: 'network_error' });
    }
  }

  async function loadData() {
    const [tRes, lRes] = await Promise.all([
      supabase.from('tasks').select('*').order('updated_at', { ascending: false }),
      supabase.from('send_logs').select('*').order('sent_at', { ascending: false }).limit(20),
    ]);
    setTasks((tRes.data as Task[]) ?? []);
    setLogs((lRes.data as SendLog[]) ?? []);
  }

  const kpis = useMemo<KPI[]>(() => {
    const active = tasks.filter((t) => t.status !== 'completed').length;
    const now = Date.now();
    const overdue = tasks.filter(
      (t) => t.status !== 'completed' && t.due_date && new Date(t.due_date).getTime() < now
    ).length;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const aiToday = tasks.filter(
      (t) => t.last_ai_nudge && new Date(t.last_ai_nudge).getTime() >= today.getTime()
    ).length;
    const completed = tasks.filter((t) => t.status === 'completed').length;
    const rate = tasks.length ? Math.round((completed / tasks.length) * 100) : 0;

    return [
      { label: 'Tarefas Ativas', value: String(active), hint: `${tasks.length} totais`, Icon: Target, glow: 'rgba(0,229,255,0.22)', accent: '#00e5ff' },
      { label: 'Atrasadas', value: String(overdue), hint: 'requer atenção', Icon: AlertTriangle, glow: 'rgba(255,77,121,0.22)', accent: '#ff4d79' },
      { label: 'Cobranças IA Hoje', value: String(aiToday), hint: 'mensagens enviadas', Icon: Bot, glow: 'rgba(179,71,255,0.22)', accent: '#b347ff' },
      { label: 'Taxa de Conclusão', value: `${rate}%`, hint: `${completed} concluídas`, Icon: CheckCircle2, glow: 'rgba(16,245,155,0.22)', accent: '#10f59b' },
    ];
  }, [tasks]);

  const weeklyData = useMemo(() => {
    const labels = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const bucket: { day: string; concluidas: number; ia: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const start = d.getTime();
      const end = start + 86400000;
      const concluidas = tasks.filter(
        (t) => t.completed_at && new Date(t.completed_at).getTime() >= start && new Date(t.completed_at).getTime() < end
      ).length;
      const ia = logs.filter(
        (l) => new Date(l.sent_at).getTime() >= start && new Date(l.sent_at).getTime() < end
      ).length;
      bucket.push({ day: labels[d.getDay()], concluidas, ia });
    }
    return bucket;
  }, [tasks, logs]);

  const aiFeed = useMemo(() => logs.slice(0, 8), [logs]);

  return (
    <div style={{ padding: '32px 36px', maxWidth: '1600px', margin: '0 auto' }}>
      <header style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: '28px', flexWrap: 'wrap', gap: '16px' }}>
        <div>
          <div style={{ fontSize: '11px', color: '#6b7384', letterSpacing: '2px', textTransform: 'uppercase', fontWeight: 600, marginBottom: '6px' }}>
            Visão Geral de Operações
          </div>
          <h1 style={{ fontSize: '32px', fontWeight: 700, color: '#f4f6fb', margin: 0, letterSpacing: '-0.5px' }}>
            Dashboard Principal
          </h1>
          <p style={{ color: '#9aa3b2', margin: '6px 0 0', fontSize: '14px' }}>
            Registro de tarefas e de cobranças enviadas pela IA via Evolution API.
          </p>
        </div>
        <div
          className="glass"
          style={{
            padding: '10px 16px',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            border: `1px solid ${whats?.connected ? 'rgba(16,245,155,0.35)' : 'rgba(255,179,71,0.35)'}`,
            background: whats?.connected ? 'rgba(16,245,155,0.08)' : 'rgba(255,179,71,0.08)',
          }}
          title={whats?.state ? `Estado da instância: ${whats.state}` : ''}
        >
          {whats?.connected ? (
            <>
              <Wifi size={16} color="#10f59b" />
              <span style={{ fontSize: '12px', color: '#10f59b', fontWeight: 600 }}>WhatsApp conectado</span>
              <span className="neon-dot" style={{ marginLeft: '4px' }} />
            </>
          ) : (
            <>
              <WifiOff size={16} color="#ffb547" />
              <span style={{ fontSize: '12px', color: '#ffb547', fontWeight: 600 }}>
                {whats === null ? 'Verificando...' : 'WhatsApp desconectado'}
              </span>
            </>
          )}
        </div>
      </header>

      {whats && !whats.connected && (
        <div
          style={{
            display: 'flex',
            gap: '12px',
            alignItems: 'flex-start',
            padding: '14px 18px',
            marginBottom: '22px',
            borderRadius: '12px',
            background: 'rgba(255,179,71,0.06)',
            border: '1px solid rgba(255,179,71,0.25)',
          }}
        >
          <AlertTriangle size={18} color="#ffb547" style={{ flexShrink: 0, marginTop: '2px' }} />
          <div style={{ fontSize: '12.5px', color: '#e6d4b0', lineHeight: 1.55 }}>
            <strong style={{ color: '#ffb547' }}>
              {whats.reason === 'not_configured'
                ? 'Evolution API não configurada.'
                : 'Instância Evolution offline.'}
            </strong>{' '}
            {whats.reason === 'not_configured'
              ? 'Preencha URL, API Key e nome da instância em Configurações para ativar o envio real.'
              : `Estado atual da instância: "${whats.state ?? 'desconhecido'}". Reconecte o QR Code no painel da Evolution API.`}{' '}
            Enquanto estiver offline, cobranças disparadas pelo botão "Cobrar via IA" retornarão erro e o cron-job.org não conseguirá enviar.
          </div>
        </div>
      )}

      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
          gap: '18px',
          marginBottom: '28px',
        }}
      >
        {kpis.map(({ label, value, hint, Icon, glow, accent }) => (
          <div
            key={label}
            className="kpi-card"
            style={{ padding: '22px', ['--kpi-glow' as string]: glow } as React.CSSProperties}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '18px' }}>
              <div
                style={{
                  width: '40px', height: '40px', borderRadius: '10px',
                  background: `${accent}18`,
                  border: `1px solid ${accent}40`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                <Icon size={18} color={accent} strokeWidth={2} />
              </div>
            </div>
            <div style={{ fontSize: '32px', fontWeight: 700, color: '#f4f6fb', letterSpacing: '-1px', lineHeight: 1 }}>
              {value}
            </div>
            <div style={{ fontSize: '13px', color: '#c6cdda', marginTop: '8px', fontWeight: 500 }}>
              {label}
            </div>
            <div style={{ fontSize: '11px', color: '#6b7384', marginTop: '2px' }}>
              {hint}
            </div>
          </div>
        ))}
      </section>

      <section style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr', gap: '20px', marginBottom: '20px' }}>
        <div className="glass" style={{ padding: '24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', flexWrap: 'wrap', gap: '10px' }}>
            <div>
              <div style={{ fontSize: '11px', color: '#6b7384', letterSpacing: '1.6px', textTransform: 'uppercase', fontWeight: 600, marginBottom: '4px' }}>
                Performance Semanal
              </div>
              <h2 style={{ fontSize: '17px', fontWeight: 600, color: '#f4f6fb', margin: 0 }}>
                Tarefas Concluídas vs. Intervenções da IA
              </h2>
            </div>
            <div style={{ display: 'flex', gap: '14px', fontSize: '11px', color: '#9aa3b2' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#10f59b' }} />
                Concluídas
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#b347ff' }} />
                IA
              </span>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={weeklyData} margin={{ top: 5, right: 10, left: -15, bottom: 0 }}>
              <CartesianGrid stroke="rgba(255,255,255,0.06)" strokeDasharray="3 3" />
              <XAxis dataKey="day" stroke="#6b7384" fontSize={11} tickLine={false} axisLine={{ stroke: 'rgba(255,255,255,0.08)' }} />
              <YAxis stroke="#6b7384" fontSize={11} tickLine={false} axisLine={false} />
              <Tooltip
                contentStyle={{
                  background: 'rgba(14,16,22,0.95)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: '10px',
                  color: '#f4f6fb',
                  fontSize: '12px',
                }}
              />
              <Line type="monotone" dataKey="concluidas" stroke="#10f59b" strokeWidth={2.5} dot={{ r: 4, fill: '#10f59b' }} activeDot={{ r: 6 }} />
              <Line type="monotone" dataKey="ia" stroke="#b347ff" strokeWidth={2.5} dot={{ r: 4, fill: '#b347ff' }} activeDot={{ r: 6 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="glass" style={{ padding: '24px' }}>
          <div style={{ marginBottom: '16px' }}>
            <div style={{ fontSize: '11px', color: '#6b7384', letterSpacing: '1.6px', textTransform: 'uppercase', fontWeight: 600, marginBottom: '4px' }}>
              Cobranças registradas
            </div>
            <h2 style={{ fontSize: '17px', fontWeight: 600, color: '#f4f6fb', margin: 0 }}>
              Últimos 7 dias
            </h2>
          </div>
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={weeklyData} margin={{ top: 5, right: 10, left: -15, bottom: 0 }}>
              <defs>
                <linearGradient id="gArea" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#00e5ff" stopOpacity={0.6} />
                  <stop offset="100%" stopColor="#00e5ff" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="rgba(255,255,255,0.06)" strokeDasharray="3 3" />
              <XAxis dataKey="day" stroke="#6b7384" fontSize={11} tickLine={false} axisLine={{ stroke: 'rgba(255,255,255,0.08)' }} />
              <YAxis stroke="#6b7384" fontSize={11} tickLine={false} axisLine={false} />
              <Tooltip
                contentStyle={{
                  background: 'rgba(14,16,22,0.95)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: '10px',
                  color: '#f4f6fb',
                  fontSize: '12px',
                }}
              />
              <Area type="monotone" dataKey="ia" stroke="#00e5ff" strokeWidth={2.5} fill="url(#gArea)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="glass" style={{ padding: '24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', flexWrap: 'wrap', gap: '10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{
              width: '36px', height: '36px', borderRadius: '10px',
              background: 'linear-gradient(135deg, #00e5ff, #b347ff)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Bot size={18} color="#07080c" strokeWidth={2.4} />
            </div>
            <div>
              <div style={{ fontSize: '11px', color: '#6b7384', letterSpacing: '1.6px', textTransform: 'uppercase', fontWeight: 600 }}>
                Feed em Tempo Real
              </div>
              <h2 style={{ fontSize: '17px', fontWeight: 600, color: '#f4f6fb', margin: 0 }}>
                Últimas mensagens enviadas pela IA
              </h2>
            </div>
          </div>
          {whats?.connected ? (
            <span className="chip" style={{ background: 'rgba(16,245,155,0.12)', color: '#10f59b', border: '1px solid rgba(16,245,155,0.3)' }}>
              <span className="neon-dot" style={{ width: '6px', height: '6px' }} /> ao vivo
            </span>
          ) : (
            <span className="chip" style={{ background: 'rgba(255,179,71,0.12)', color: '#ffb547', border: '1px solid rgba(255,179,71,0.3)' }}>
              <WifiOff size={11} /> offline
            </span>
          )}
        </div>

        {aiFeed.length === 0 ? (
          <div style={{ padding: '32px', textAlign: 'center', color: '#6b7384', fontSize: '13px' }}>
            Nenhuma mensagem da IA registrada ainda.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {aiFeed.map((log) => (
              <div
                key={log.id}
                style={{
                  display: 'flex',
                  gap: '14px',
                  padding: '14px 16px',
                  borderRadius: '12px',
                  background: 'rgba(255,255,255,0.025)',
                  border: '1px solid rgba(255,255,255,0.05)',
                }}
              >
                <div style={{
                  width: '34px', height: '34px', borderRadius: '10px',
                  background: log.status === 'sent' ? 'rgba(16,245,155,0.12)' : 'rgba(255,77,121,0.12)',
                  border: `1px solid ${log.status === 'sent' ? 'rgba(16,245,155,0.3)' : 'rgba(255,77,121,0.3)'}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}>
                  <MessageSquare size={15} color={log.status === 'sent' ? '#10f59b' : '#ff4d79'} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '4px', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '13px', fontWeight: 600, color: '#f4f6fb' }}>
                      {log.contact_name || 'Grupo'}
                    </span>
                    <span style={{ fontSize: '11px', color: '#6b7384' }}>•</span>
                    <span style={{ fontSize: '11px', color: '#9aa3b2' }}>{log.template_name || 'Cobrança IA'}</span>
                    <span style={{ fontSize: '11px', color: '#6b7384', marginLeft: 'auto' }}>{formatRelative(log.sent_at)}</span>
                  </div>
                  <div style={{ fontSize: '12.5px', color: '#c6cdda', lineHeight: 1.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {log.message_content || '(mensagem vazia)'}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
