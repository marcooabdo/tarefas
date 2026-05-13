import { useEffect, useState } from 'react';
import { Bot, Clock, Save, Plus, X, MessageSquare, Eye, Reply, TriangleAlert as AlertTriangle } from 'lucide-react';
import { supabase } from '../lib/supabase';

interface Settings {
  schedule: string[];
  systemPrompt: string;
  autoReadGroups: boolean;
  autoReply: boolean;
  proactiveOverdue: boolean;
}

const defaults: Settings = {
  schedule: ['09:00', '14:00', '17:00'],
  systemPrompt:
    'Você é a GIA, Executive Advisor do Sr. Marco Abdo, IA responsável pela gestão de tarefas e pendências das operações do Group Global. Tom profissional, cordial, breve e direto. Trate a pessoa pelo primeiro nome quando souber. Nunca se identifique como assistente genérica nem como ChatGPT/OpenAI. Sempre fale em português do Brasil. Mensagens devem ser curtas (3 a 6 linhas) e adequadas ao WhatsApp. Não use markdown além de *negrito*. Não use emojis a não ser que o contexto peça. Quando pedir status de tarefa, sempre apresente exatamente as 3 opções numeradas: 1 - Concluída, 2 - Em execução, 3 - Bloqueada. Sempre inclua a referência da tarefa quando fornecida.',
  autoReadGroups: true,
  autoReply: true,
  proactiveOverdue: true,
};

export function Automation() {
  const [s, setS] = useState<Settings>(defaults);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newTime, setNewTime] = useState('09:00');
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    const { data } = await supabase.from('app_settings').select('*');
    const map = new Map((data ?? []).map((r: any) => [r.key, r.value]));
    setS({
      schedule: map.get('ai_schedule_cron')?.split(',').map((x: string) => x.trim()).filter(Boolean) ?? defaults.schedule,
      systemPrompt: map.get('ai_system_prompt') ?? defaults.systemPrompt,
      autoReadGroups: map.get('ai_auto_read_groups') !== 'false',
      autoReply: map.get('ai_auto_reply') !== 'false',
      proactiveOverdue: map.get('ai_proactive_overdue') !== 'false',
    });
    setLoading(false);
  }

  async function save() {
    setSaving(true);
    const rows = [
      { key: 'ai_schedule_cron', value: s.schedule.join(',') },
      { key: 'ai_system_prompt', value: s.systemPrompt },
      { key: 'ai_auto_read_groups', value: String(s.autoReadGroups) },
      { key: 'ai_auto_reply', value: String(s.autoReply) },
      { key: 'ai_proactive_overdue', value: String(s.proactiveOverdue) },
    ];
    await Promise.all(
      rows.map((r) => supabase.from('app_settings').upsert(r, { onConflict: 'key' }))
    );
    setSaving(false);
    setSavedAt(new Date());
  }

  function addTime() {
    if (!newTime || s.schedule.includes(newTime)) return;
    setS({ ...s, schedule: [...s.schedule, newTime].sort() });
  }

  function removeTime(t: string) {
    setS({ ...s, schedule: s.schedule.filter((x) => x !== t) });
  }

  if (loading) {
    return <div style={{ padding: '60px', textAlign: 'center', color: '#6b7384' }}>Carregando...</div>;
  }

  return (
    <div style={{ padding: '32px 36px', maxWidth: '1200px', margin: '0 auto' }}>
      <header style={{ marginBottom: '28px' }}>
        <div style={{ fontSize: '11px', color: '#6b7384', letterSpacing: '2px', textTransform: 'uppercase', fontWeight: 600, marginBottom: '6px' }}>
          Configurações do Gestor IA
        </div>
        <h1 style={{ fontSize: '32px', fontWeight: 700, color: '#f4f6fb', margin: 0, letterSpacing: '-0.5px' }}>
          Automação e IA
        </h1>
        <p style={{ color: '#9aa3b2', margin: '6px 0 0', fontSize: '14px' }}>
          Controla os horários, o prompt e o comportamento do gestor IA no WhatsApp.
        </p>
      </header>

      <div
        style={{
          display: 'flex',
          gap: '12px',
          alignItems: 'flex-start',
          padding: '14px 18px',
          marginBottom: '22px',
          borderRadius: '12px',
          background: 'rgba(0,229,255,0.05)',
          border: '1px solid rgba(0,229,255,0.25)',
        }}
      >
        <AlertTriangle size={18} color="#00e5ff" style={{ flexShrink: 0, marginTop: '2px' }} />
        <div style={{ fontSize: '12.5px', color: '#c6e8ed', lineHeight: 1.55 }}>
          <strong style={{ color: '#00e5ff' }}>Como funciona:</strong>{' '}
          O cron-job.org externo chama a Edge Function <code style={{ color: '#00e5ff' }}>send-scheduled-messages</code> a cada minuto. A função confere se o horário atual bate com algum agendamento ativo e, se sim, envia via Evolution API.
          Respostas dos contatos chegam pelo webhook <code style={{ color: '#00e5ff' }}>whatsapp-webhook</code>, que interpreta a mensagem e move a tarefa para "Em Execução", "Concluído" ou "Pendente" automaticamente.
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '20px' }}>
        <section className="glass" style={{ padding: '24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '18px' }}>
            <div style={{
              width: '40px', height: '40px', borderRadius: '10px',
              background: 'rgba(0,229,255,0.12)', border: '1px solid rgba(0,229,255,0.35)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Clock size={18} color="#00e5ff" />
            </div>
            <div>
              <h2 style={{ fontSize: '16px', fontWeight: 600, color: '#f4f6fb', margin: 0 }}>Agendamentos de Cobrança</h2>
              <p style={{ fontSize: '12px', color: '#9aa3b2', margin: '4px 0 0' }}>
                Horários em que a IA enviará lembretes ao grupo.
              </p>
            </div>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '14px' }}>
            {s.schedule.map((t) => (
              <span
                key={t}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: '8px',
                  padding: '8px 12px', borderRadius: '10px',
                  background: 'rgba(0,229,255,0.08)',
                  border: '1px solid rgba(0,229,255,0.3)',
                  color: '#00e5ff', fontSize: '13px', fontWeight: 600, fontFamily: 'monospace',
                }}
              >
                {t}
                <button
                  onClick={() => removeTime(t)}
                  style={{ background: 'transparent', border: 'none', color: '#00e5ff', cursor: 'pointer', display: 'flex' }}
                  aria-label={`Remover ${t}`}
                >
                  <X size={12} />
                </button>
              </span>
            ))}
            {s.schedule.length === 0 && (
              <span style={{ color: '#6b7384', fontSize: '13px' }}>Nenhum horário configurado.</span>
            )}
          </div>

          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <input
              type="time"
              value={newTime}
              onChange={(e) => setNewTime(e.target.value)}
              className="nx-input"
              style={{ width: '140px' }}
            />
            <button onClick={addTime} className="ghost-btn">
              <Plus size={14} /> Adicionar horário
            </button>
          </div>
        </section>

        <section className="glass" style={{ padding: '24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '18px' }}>
            <div style={{
              width: '40px', height: '40px', borderRadius: '10px',
              background: 'rgba(179,71,255,0.12)', border: '1px solid rgba(179,71,255,0.35)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Bot size={18} color="#b347ff" />
            </div>
            <div>
              <h2 style={{ fontSize: '16px', fontWeight: 600, color: '#f4f6fb', margin: 0 }}>System Prompt da IA</h2>
              <p style={{ fontSize: '12px', color: '#9aa3b2', margin: '4px 0 0' }}>
                Instruções de comportamento, tom e persona do gestor virtual.
              </p>
            </div>
          </div>

          <textarea
            className="nx-input"
            rows={8}
            value={s.systemPrompt}
            onChange={(e) => setS({ ...s, systemPrompt: e.target.value })}
            style={{ fontFamily: 'inherit', lineHeight: 1.6 }}
          />
          <div style={{ fontSize: '11px', color: '#6b7384', marginTop: '8px' }}>
            {s.systemPrompt.length} caracteres
          </div>
        </section>

        <section className="glass" style={{ padding: '24px' }}>
          <div style={{ marginBottom: '18px' }}>
            <h2 style={{ fontSize: '16px', fontWeight: 600, color: '#f4f6fb', margin: 0 }}>Comportamentos do WhatsApp</h2>
            <p style={{ fontSize: '12px', color: '#9aa3b2', margin: '4px 0 0' }}>
              Define como a IA interage com o canal da equipe.
            </p>
          </div>

          <ToggleRow
            icon={<Eye size={16} color="#00e5ff" />}
            title="Leitura automática de grupos"
            description='Quando ativada, respostas recebidas no WhatsApp (inclusive em grupos) chegam pelo webhook da Evolution e a IA interpreta palavras como "feito", "fazendo", "bloqueado", "sim", "não", movendo a tarefa automaticamente.'
            checked={s.autoReadGroups}
            onChange={(v) => setS({ ...s, autoReadGroups: v })}
          />
          <div style={{ height: '1px', background: 'rgba(255,255,255,0.05)', margin: '14px 0' }} />
          <ToggleRow
            icon={<Reply size={16} color="#b347ff" />}
            title="Resposta automática no grupo"
            description="Depois de interpretar a resposta, a IA envia uma confirmação de volta pelo mesmo canal (privado ou grupo), usando a Evolution API. Se a intenção não for clara, ela pergunta se é 1) concluída, 2) em andamento ou 3) bloqueada."
            checked={s.autoReply}
            onChange={(v) => setS({ ...s, autoReply: v })}
          />
          <div style={{ height: '1px', background: 'rgba(255,255,255,0.05)', margin: '14px 0' }} />
          <ToggleRow
            icon={<MessageSquare size={16} color="#10f59b" />}
            title="Cobrança proativa de atrasos"
            description="A cada execução do cron (horários abaixo), a IA busca tarefas com prazo vencido sem atualização nas últimas 6h e envia uma cobrança automática pela Evolution. Independe de agendamentos de templates — depende apenas da existência de tarefas atrasadas."
            checked={s.proactiveOverdue}
            onChange={(v) => setS({ ...s, proactiveOverdue: v })}
          />
        </section>

        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '14px' }}>
          {savedAt && (
            <span style={{ fontSize: '12px', color: '#10f59b' }}>
              Configurações salvas às {savedAt.toLocaleTimeString('pt-BR')}
            </span>
          )}
          <button onClick={save} className="neon-btn" disabled={saving}>
            <Save size={14} />
            {saving ? 'Salvando...' : 'Salvar alterações'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ToggleRow({
  icon, title, description, checked, onChange, disabled,
}: {
  icon: React.ReactNode; title: string; description: string;
  checked: boolean; onChange: (v: boolean) => void; disabled?: boolean;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '14px', opacity: disabled ? 0.6 : 1 }}>
      <div style={{
        width: '36px', height: '36px', borderRadius: '10px',
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.08)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        {icon}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '13.5px', fontWeight: 600, color: '#f4f6fb' }}>{title}</div>
        <div style={{ fontSize: '12px', color: '#9aa3b2', marginTop: '2px' }}>{description}</div>
      </div>
      <label className={`toggle ${checked ? 'on' : ''}`} style={{ cursor: disabled ? 'not-allowed' : 'pointer' }}>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          style={{ display: 'none' }}
        />
        <span className="toggle-knob" />
      </label>
    </div>
  );
}
