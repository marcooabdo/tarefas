import { useEffect, useMemo, useState } from 'react';
import { Save, Plug, CircleCheck as CheckCircle2, CircleAlert as AlertCircle, Eye, EyeOff, Webhook, Copy, Bell } from 'lucide-react';
import { supabase } from '../lib/supabase';

interface SettingsState {
  evolution_api_url: string;
  evolution_api_key: string;
  evolution_instance_name: string;
  gia_report_phone: string;
  default_nudge_hours: string;
  default_repeat_hours: string;
  default_max_nudges: string;
}

export function Settings() {
  const [settings, setSettings] = useState<SettingsState>({
    evolution_api_url: '',
    evolution_api_key: '',
    evolution_instance_name: '',
    gia_report_phone: '',
    default_nudge_hours: '1',
    default_repeat_hours: '4',
    default_max_nudges: '0',
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [apiTestResult, setApiTestResult] = useState<'success' | 'error' | null>(null);
  const [apiTestMessage, setApiTestMessage] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [webhookBusy, setWebhookBusy] = useState(false);
  const [webhookMsg, setWebhookMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [webhookInfo, setWebhookInfo] = useState<{ url?: string; enabled?: boolean; events?: string[] } | null>(null);
  const [checkingWebhook, setCheckingWebhook] = useState(false);

  const webhookUrl = useMemo(
    () => `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/whatsapp-webhook`,
    []
  );

  useEffect(() => { loadSettings(); }, []);

  async function loadSettings() {
    setLoading(true);
    const { data } = await supabase
      .from('app_settings')
      .select('key, value')
      .in('key', [
        'evolution_api_url', 'evolution_api_key', 'evolution_instance_name', 'gia_report_phone',
        'default_nudge_hours', 'default_repeat_hours', 'default_max_nudges',
      ]);
    const map: Record<string, string> = {};
    (data ?? []).forEach((s: any) => (map[s.key] = s.value));
    setSettings({
      evolution_api_url: map.evolution_api_url ?? '',
      evolution_api_key: map.evolution_api_key ?? '',
      evolution_instance_name: map.evolution_instance_name ?? '',
      gia_report_phone: map.gia_report_phone ?? '',
      default_nudge_hours: map.default_nudge_hours ?? '1',
      default_repeat_hours: map.default_repeat_hours ?? '4',
      default_max_nudges: map.default_max_nudges ?? '0',
    });
    setLoading(false);
  }

  async function handleSave() {
    setError('');
    setSaved(false);
    if (!settings.evolution_api_url.trim()) {
      setError('A URL da Evolution API é obrigatória.');
      return;
    }
    setSaving(true);
    try {
      const updates = Object.entries(settings).map(([key, value]) =>
        supabase.from('app_settings').upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' })
      );
      await Promise.all(updates);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch {
      setError('Erro ao salvar configurações.');
    } finally {
      setSaving(false);
    }
  }

  async function handleTestApi() {
    setApiTestResult(null);
    setApiTestMessage('');
    if (!settings.evolution_api_url || !settings.evolution_api_key) {
      setApiTestResult('error');
      setApiTestMessage('Preencha a URL e a API Key antes de testar.');
      return;
    }
    setTesting(true);
    try {
      const base = settings.evolution_api_url.replace(/\/$/, '');
      const url = settings.evolution_instance_name
        ? `${base}/instance/connectionState/${settings.evolution_instance_name}`
        : `${base}/instance/fetchInstances`;
      const res = await fetch(url, {
        headers: { apikey: settings.evolution_api_key },
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const data = await res.json();
        const state = data?.instance?.state ?? data?.state;
        if (state) {
          setApiTestResult(state === 'open' || state === 'connected' ? 'success' : 'error');
          setApiTestMessage(`Estado da instância: ${state}`);
        } else {
          const count = Array.isArray(data) ? data.length : 0;
          setApiTestResult('success');
          setApiTestMessage(`Conectado. ${count} instância(s) encontrada(s).`);
        }
      } else {
        setApiTestResult('error');
        setApiTestMessage(`Falha na conexão: HTTP ${res.status} ${res.statusText}`);
      }
    } catch (e: any) {
      setApiTestResult('error');
      setApiTestMessage(`Erro de conexão: ${e.message ?? 'Timeout ou servidor inacessível'}`);
    } finally {
      setTesting(false);
    }
  }

  async function handleCheckWebhook() {
    setWebhookMsg(null);
    setWebhookInfo(null);
    if (!settings.evolution_api_url || !settings.evolution_api_key || !settings.evolution_instance_name) {
      setWebhookMsg({ kind: 'error', text: 'Preencha e salve a URL, API Key e Instância antes.' });
      return;
    }
    setCheckingWebhook(true);
    try {
      const base = settings.evolution_api_url.replace(/\/$/, '');
      const res = await fetch(`${base}/webhook/find/${encodeURIComponent(settings.evolution_instance_name)}`, {
        headers: { apikey: settings.evolution_api_key },
      });
      if (!res.ok) {
        setWebhookMsg({ kind: 'error', text: `Não foi possível consultar o webhook (HTTP ${res.status}).` });
        return;
      }
      const data = await res.json();
      const info = {
        url: data?.url ?? data?.webhook?.url,
        enabled: data?.enabled ?? data?.webhook?.enabled,
        events: data?.events ?? data?.webhook?.events,
      };
      setWebhookInfo(info);
      if (!info.url) {
        setWebhookMsg({ kind: 'error', text: 'Nenhum webhook configurado na instância. Clique em "Configurar webhook".' });
      } else if (info.url.trim() !== webhookUrl.trim()) {
        setWebhookMsg({ kind: 'error', text: `Webhook aponta para outra URL: ${info.url}` });
      } else if (info.enabled === false) {
        setWebhookMsg({ kind: 'error', text: 'Webhook existe mas está desativado.' });
      } else if (!(info.events ?? []).map((e: string) => e.toUpperCase()).includes('MESSAGES_UPSERT')) {
        setWebhookMsg({ kind: 'error', text: 'Webhook ativo, mas sem o evento MESSAGES_UPSERT habilitado.' });
      } else {
        setWebhookMsg({ kind: 'success', text: 'Webhook ativo e apontando para a URL correta.' });
      }
    } catch (e: any) {
      setWebhookMsg({ kind: 'error', text: `Erro: ${e?.message ?? e}` });
    } finally {
      setCheckingWebhook(false);
    }
  }

  async function handleConfigureWebhook() {
    setWebhookMsg(null);
    if (!settings.evolution_api_url || !settings.evolution_api_key || !settings.evolution_instance_name) {
      setWebhookMsg({ kind: 'error', text: 'Preencha e salve a URL, API Key e Instância antes.' });
      return;
    }
    setWebhookBusy(true);
    try {
      const base = settings.evolution_api_url.replace(/\/$/, '');
      const body = {
        webhook: {
          enabled: true,
          url: webhookUrl,
          webhookByEvents: false,
          webhookBase64: false,
          events: ['MESSAGES_UPSERT'],
        },
      };
      let res = await fetch(`${base}/webhook/set/${encodeURIComponent(settings.evolution_instance_name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: settings.evolution_api_key },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        res = await fetch(`${base}/webhook/set/${encodeURIComponent(settings.evolution_instance_name)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: settings.evolution_api_key },
          body: JSON.stringify({ enabled: true, url: webhookUrl, events: ['MESSAGES_UPSERT'] }),
        });
      }
      if (res.ok) {
        setWebhookMsg({ kind: 'success', text: 'Webhook configurado com sucesso na Evolution API.' });
      } else {
        const txt = await res.text();
        setWebhookMsg({ kind: 'error', text: `Falha ao configurar webhook: HTTP ${res.status} ${txt.slice(0, 140)}` });
      }
    } catch (e: any) {
      setWebhookMsg({ kind: 'error', text: `Erro: ${e?.message ?? e}` });
    } finally {
      setWebhookBusy(false);
    }
  }

  async function copyWebhook() {
    try {
      await navigator.clipboard.writeText(webhookUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {}
  }

  return (
    <div style={{ padding: '32px 36px', maxWidth: '900px', margin: '0 auto' }}>
      <header style={{ marginBottom: '28px' }}>
        <div style={{ fontSize: '11px', color: '#6b7384', letterSpacing: '2px', textTransform: 'uppercase', fontWeight: 600, marginBottom: '6px' }}>
          Integração
        </div>
        <h1 style={{ fontSize: '32px', fontWeight: 700, color: '#f4f6fb', margin: 0, letterSpacing: '-0.5px' }}>
          Configurações
        </h1>
        <p style={{ color: '#9aa3b2', margin: '6px 0 0', fontSize: '14px' }}>
          Credenciais da Evolution API usadas para enviar mensagens via WhatsApp.
        </p>
      </header>

      {loading ? (
        <div style={{ padding: '60px', textAlign: 'center', color: '#6b7384' }}>Carregando...</div>
      ) : (
        <>
          <section className="glass" style={{ padding: '26px', marginBottom: '18px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '22px' }}>
              <div style={{
                width: '42px', height: '42px', borderRadius: '11px',
                background: 'linear-gradient(135deg, rgba(16,245,155,0.18), rgba(0,229,255,0.18))',
                border: '1px solid rgba(16,245,155,0.35)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <Plug size={20} color="#10f59b" />
              </div>
              <div>
                <h2 style={{ fontSize: '16px', fontWeight: 600, color: '#f4f6fb', margin: 0 }}>Evolution API</h2>
                <p style={{ fontSize: '12px', color: '#9aa3b2', margin: '4px 0 0' }}>
                  Informe a URL do servidor, a API Key e o nome da instância conectada ao QR Code.
                </p>
              </div>
            </div>

            {error && (
              <div style={{
                display: 'flex', gap: '10px', alignItems: 'center',
                padding: '10px 14px', borderRadius: '10px', marginBottom: '14px',
                background: 'rgba(255,77,121,0.08)', border: '1px solid rgba(255,77,121,0.35)',
                color: '#ff4d79', fontSize: '12.5px',
              }}>
                <AlertCircle size={15} /> {error}
              </div>
            )}
            {saved && (
              <div style={{
                display: 'flex', gap: '10px', alignItems: 'center',
                padding: '10px 14px', borderRadius: '10px', marginBottom: '14px',
                background: 'rgba(16,245,155,0.08)', border: '1px solid rgba(16,245,155,0.35)',
                color: '#10f59b', fontSize: '12.5px',
              }}>
                <CheckCircle2 size={15} /> Configurações salvas com sucesso.
              </div>
            )}
            {apiTestResult && (
              <div style={{
                display: 'flex', gap: '10px', alignItems: 'center',
                padding: '10px 14px', borderRadius: '10px', marginBottom: '14px',
                background: apiTestResult === 'success' ? 'rgba(16,245,155,0.08)' : 'rgba(255,77,121,0.08)',
                border: `1px solid ${apiTestResult === 'success' ? 'rgba(16,245,155,0.35)' : 'rgba(255,77,121,0.35)'}`,
                color: apiTestResult === 'success' ? '#10f59b' : '#ff4d79', fontSize: '12.5px',
              }}>
                {apiTestResult === 'success' ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}
                {apiTestMessage}
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <Field label="URL da Evolution API" hint="URL base do servidor, sem barra no final">
                <input
                  className="nx-input"
                  placeholder="https://api.evolution.example.com"
                  value={settings.evolution_api_url}
                  onChange={(e) => setSettings({ ...settings, evolution_api_url: e.target.value })}
                />
              </Field>

              <Field label="API Key" hint="Chave de autenticação da Evolution API">
                <div style={{ position: 'relative' }}>
                  <input
                    className="nx-input"
                    type={showKey ? 'text' : 'password'}
                    placeholder="sua-api-key-aqui"
                    value={settings.evolution_api_key}
                    onChange={(e) => setSettings({ ...settings, evolution_api_key: e.target.value })}
                    style={{ paddingRight: '40px' }}
                  />
                  <button
                    onClick={() => setShowKey((v) => !v)}
                    type="button"
                    aria-label={showKey ? 'Ocultar chave' : 'Mostrar chave'}
                    style={{
                      position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)',
                      background: 'transparent', border: 'none', color: '#9aa3b2', cursor: 'pointer',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}
                  >
                    {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </Field>

              <Field label="Nome da Instância" hint="Nome exato da instância WhatsApp configurada na Evolution API">
                <input
                  className="nx-input"
                  placeholder="minha-instancia"
                  value={settings.evolution_instance_name}
                  onChange={(e) => setSettings({ ...settings, evolution_instance_name: e.target.value })}
                />
              </Field>

              <Field label="WhatsApp para Relatórios (GIA)" hint="Número que recebe o relatório de tarefas vencidas (ex: 5534999990000)">
                <input
                  className="nx-input"
                  type="tel"
                  placeholder="5534999990000"
                  value={settings.gia_report_phone}
                  onChange={(e) => setSettings({ ...settings, gia_report_phone: e.target.value.replace(/\D/g, '') })}
                />
              </Field>
            </div>

            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '22px' }}>
              <button className="ghost-btn" disabled={testing} onClick={handleTestApi}>
                {testing ? 'Testando...' : 'Testar Conexão'}
              </button>
              <button className="neon-btn" disabled={saving} onClick={handleSave}>
                <Save size={14} /> {saving ? 'Salvando...' : 'Salvar Configurações'}
              </button>
            </div>
          </section>

          <section className="glass" style={{ padding: '26px', marginBottom: '18px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '18px' }}>
              <div style={{
                width: '42px', height: '42px', borderRadius: '11px',
                background: 'linear-gradient(135deg, rgba(0,229,255,0.18), rgba(16,245,155,0.18))',
                border: '1px solid rgba(0,229,255,0.35)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <Webhook size={20} color="#00e5ff" />
              </div>
              <div>
                <h2 style={{ fontSize: '16px', fontWeight: 600, color: '#f4f6fb', margin: 0 }}>Webhook de respostas</h2>
                <p style={{ fontSize: '12px', color: '#9aa3b2', margin: '4px 0 0' }}>
                  Sem isso, a IA não consegue ler as respostas (1, 2 ou 3) que atualizam o Kanban.
                </p>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '14px' }}>
              <input className="nx-input" readOnly value={webhookUrl} style={{ fontFamily: 'monospace', fontSize: '12px' }} />
              <button className="ghost-btn" onClick={copyWebhook} type="button" title="Copiar URL">
                <Copy size={13} /> {copied ? 'Copiado' : 'Copiar'}
              </button>
            </div>

            {webhookMsg && (
              <div style={{
                display: 'flex', gap: '10px', alignItems: 'center',
                padding: '10px 14px', borderRadius: '10px', marginBottom: '14px',
                background: webhookMsg.kind === 'success' ? 'rgba(16,245,155,0.08)' : 'rgba(255,77,121,0.08)',
                border: `1px solid ${webhookMsg.kind === 'success' ? 'rgba(16,245,155,0.35)' : 'rgba(255,77,121,0.35)'}`,
                color: webhookMsg.kind === 'success' ? '#10f59b' : '#ff4d79', fontSize: '12.5px',
              }}>
                {webhookMsg.kind === 'success' ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}
                {webhookMsg.text}
              </div>
            )}

            {webhookInfo && (
              <div style={{
                padding: '10px 14px', borderRadius: '10px', marginBottom: '14px',
                background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
                fontSize: '12px', color: '#9aa3b2', fontFamily: 'monospace',
                whiteSpace: 'pre-wrap', wordBreak: 'break-all',
              }}>
                <div>url: {webhookInfo.url ?? '(vazio)'}</div>
                <div>enabled: {String(webhookInfo.enabled ?? 'n/d')}</div>
                <div>events: {(webhookInfo.events ?? []).join(', ') || '(nenhum)'}</div>
              </div>
            )}

            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              <button className="ghost-btn" disabled={checkingWebhook} onClick={handleCheckWebhook} type="button">
                {checkingWebhook ? 'Consultando...' : 'Verificar webhook atual'}
              </button>
              <button className="neon-btn" disabled={webhookBusy} onClick={handleConfigureWebhook} type="button">
                <Webhook size={14} /> {webhookBusy ? 'Configurando...' : 'Configurar webhook na Evolution'}
              </button>
            </div>
          </section>

          <section className="glass" style={{ padding: '26px', marginBottom: '18px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '22px' }}>
              <div style={{
                width: '42px', height: '42px', borderRadius: '11px',
                background: 'linear-gradient(135deg, rgba(255,193,7,0.18), rgba(255,152,0,0.18))',
                border: '1px solid rgba(255,193,7,0.35)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <Bell size={20} color="#ffc107" />
              </div>
              <div>
                <h2 style={{ fontSize: '16px', fontWeight: 600, color: '#f4f6fb', margin: 0 }}>Cobranças de Tarefas</h2>
                <p style={{ fontSize: '12px', color: '#9aa3b2', margin: '4px 0 0' }}>
                  Configure os intervalos padrão de cobrança automática para novas tarefas.
                </p>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <Field label="Primeira cobrança após (horas)" hint="Quantas horas após o prazo vencer a GIA envia a primeira cobrança. Ex: 1 = cobra 1h depois do prazo.">
                <input
                  className="nx-input"
                  type="number"
                  min="0"
                  step="1"
                  placeholder="1"
                  value={settings.default_nudge_hours}
                  onChange={(e) => setSettings({ ...settings, default_nudge_hours: e.target.value })}
                />
              </Field>

              <Field label="Repetir cobrança a cada (horas)" hint="Se não responder, a GIA repete a cobrança neste intervalo. Ex: 4 = cobra novamente a cada 4h.">
                <input
                  className="nx-input"
                  type="number"
                  min="0"
                  step="1"
                  placeholder="4"
                  value={settings.default_repeat_hours}
                  onChange={(e) => setSettings({ ...settings, default_repeat_hours: e.target.value })}
                />
              </Field>

              <Field label="Limite de cobranças (0 = ilimitado)" hint="Quantas vezes no máximo a GIA deve cobrar antes de parar. 0 = cobra indefinidamente até responder.">
                <input
                  className="nx-input"
                  type="number"
                  min="0"
                  step="1"
                  placeholder="0"
                  value={settings.default_max_nudges}
                  onChange={(e) => setSettings({ ...settings, default_max_nudges: e.target.value })}
                />
              </Field>
            </div>

            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '22px' }}>
              <button className="neon-btn" disabled={saving} onClick={handleSave}>
                <Save size={14} /> {saving ? 'Salvando...' : 'Salvar'}
              </button>
            </div>
          </section>

          <section className="glass" style={{ padding: '24px' }}>
            <h2 style={{ fontSize: '15px', fontWeight: 600, color: '#f4f6fb', margin: '0 0 16px' }}>
              Como usar a Evolution API
            </h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {[
                { step: '1', title: 'Instale a Evolution API', desc: 'Deploy da Evolution API v2 em um servidor seguindo a documentação oficial.' },
                { step: '2', title: 'Crie uma instância', desc: 'No painel da Evolution API, crie a instância e conecte o número WhatsApp via QR Code.' },
                { step: '3', title: 'Preencha os campos acima', desc: 'URL do servidor, API Key e nome exato da instância.' },
                { step: '4', title: 'Teste a conexão', desc: 'Use o botão "Testar Conexão" para validar as credenciais e o estado da instância.' },
              ].map((it) => (
                <div key={it.step} style={{ display: 'flex', gap: '14px', alignItems: 'flex-start' }}>
                  <div style={{
                    width: '28px', height: '28px', borderRadius: '50%',
                    background: 'linear-gradient(135deg, #00e5ff, #b347ff)',
                    color: '#07080c', fontSize: '12px', fontWeight: 700,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                  }}>
                    {it.step}
                  </div>
                  <div>
                    <div style={{ fontSize: '13.5px', fontWeight: 600, color: '#f4f6fb' }}>{it.title}</div>
                    <div style={{ fontSize: '12px', color: '#9aa3b2', marginTop: '2px' }}>{it.desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </>
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
