import { useEffect, useState } from 'react';
import { Plus, Search, Trash2, X, Send, Building2, Tag, Clock, CircleCheck as CheckCircle, CircleAlert as AlertCircle } from 'lucide-react';
import { supabase } from '../lib/supabase';
import type { Contact, CLevelGroup, CLevelBroadcast } from '../lib/types';

const cardBg = 'rgba(255,255,255,0.03)';
const border = 'rgba(255,255,255,0.08)';
const inputBg = 'rgba(0,0,0,0.3)';

export function CLevelGroups() {
  const [groups, setGroups] = useState<CLevelGroup[]>([]);
  const [allContacts, setAllContacts] = useState<Contact[]>([]);
  const [broadcasts, setBroadcasts] = useState<CLevelBroadcast[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const [addModalOpen, setAddModalOpen] = useState(false);
  const [addCity, setAddCity] = useState('');
  const [addLabel, setAddLabel] = useState('');
  const [addContactId, setAddContactId] = useState('');
  const [addSearch, setAddSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [broadcastOpen, setBroadcastOpen] = useState(false);
  const [bcMessage, setBcMessage] = useState('');
  const [bcDeadline, setBcDeadline] = useState('');
  const [bcCities, setBcCities] = useState<string[]>([]);
  const [bcSending, setBcSending] = useState(false);
  const [bcError, setBcError] = useState('');
  const [bcResult, setBcResult] = useState<{ sent: number; total: number } | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<CLevelGroup | null>(null);

  useEffect(() => { loadAll(); }, []);

  async function loadAll() {
    setLoading(true);
    const [{ data: gData }, { data: cData }, { data: bData }] = await Promise.all([
      supabase.from('clevel_groups').select('*, contacts(id, name, remote_jid)').order('city').order('created_at'),
      supabase.from('contacts').select('id, name, phone, is_group, remote_jid').eq('active', true).eq('is_group', true).order('name'),
      supabase.from('clevel_broadcasts').select('*').order('created_at', { ascending: false }).limit(20),
    ]);
    setGroups((gData as CLevelGroup[]) ?? []);
    setAllContacts((cData as Contact[]) ?? []);
    setBroadcasts((bData as CLevelBroadcast[]) ?? []);
    setLoading(false);
  }

  const cities = [...new Set(groups.map((g) => g.city))].sort();
  const taggedContactIds = new Set(groups.map((g) => g.contact_id));
  const availableContacts = allContacts.filter((c) => !taggedContactIds.has(c.id));

  const filteredGroups = groups.filter((g) => {
    const q = search.toLowerCase();
    const contactName = g.contacts?.name ?? '';
    return g.city.toLowerCase().includes(q) || contactName.toLowerCase().includes(q) || g.label.toLowerCase().includes(q);
  });

  const groupsByCity: Record<string, CLevelGroup[]> = {};
  for (const g of filteredGroups) {
    if (!groupsByCity[g.city]) groupsByCity[g.city] = [];
    groupsByCity[g.city].push(g);
  }

  async function handleAdd() {
    setError('');
    if (!addContactId) { setError('Selecione um grupo do WhatsApp.'); return; }
    if (!addCity.trim()) { setError('Informe a cidade.'); return; }
    setSaving(true);
    const { error: err } = await supabase.from('clevel_groups').insert({
      contact_id: addContactId,
      city: addCity.trim(),
      label: addLabel.trim(),
    });
    setSaving(false);
    if (err) { setError(err.message); return; }
    setAddModalOpen(false);
    setAddCity(''); setAddLabel(''); setAddContactId(''); setAddSearch('');
    loadAll();
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    await supabase.from('clevel_groups').delete().eq('id', deleteTarget.id);
    setDeleteTarget(null);
    loadAll();
  }

  function openBroadcast() {
    setBcMessage(''); setBcDeadline(''); setBcCities([]); setBcError(''); setBcResult(null);
    setBroadcastOpen(true);
  }

  function toggleBcCity(city: string) {
    setBcCities((prev) => prev.includes(city) ? prev.filter((c) => c !== city) : [...prev, city]);
  }

  function selectAllCities() {
    setBcCities((prev) => prev.length === cities.length ? [] : [...cities]);
  }

  async function handleBroadcast() {
    setBcError(''); setBcResult(null);
    if (bcCities.length === 0) { setBcError('Selecione ao menos uma cidade.'); return; }
    if (!bcMessage.trim()) { setBcError('A mensagem e obrigatoria.'); return; }

    setBcSending(true);
    try {
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/send-clevel-broadcast`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cities: bcCities, message: bcMessage.trim(), deadline: bcDeadline.trim() }),
      });
      const json = await res.json();
      if (!res.ok) { setBcError(json.error || `Erro ${res.status}`); setBcSending(false); return; }
      setBcResult({ sent: json.groups_sent, total: json.groups_targeted });
      loadAll();
    } catch (err: unknown) {
      setBcError(err instanceof Error ? err.message : 'Erro de rede');
    }
    setBcSending(false);
  }

  const filteredAddContacts = availableContacts.filter((c) =>
    c.name.toLowerCase().includes(addSearch.toLowerCase())
  );

  return (
    <div style={{ maxWidth: '1100px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '28px', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: 700, color: '#f4f6fb', margin: 0 }}>Grupos C-LEVEL</h1>
          <p style={{ fontSize: '13px', color: '#6b7384', margin: '4px 0 0' }}>Gerencie grupos C-LEVEL por cidade e envie mensagens em massa</p>
        </div>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          <button onClick={openBroadcast} disabled={cities.length === 0} style={btnStyle('#b347ff')}>
            <Send size={15} /> Enviar Broadcast
          </button>
          <button onClick={() => { setAddModalOpen(true); setError(''); setAddCity(''); setAddLabel(''); setAddContactId(''); setAddSearch(''); }} style={btnStyle('#00e5ff')}>
            <Plus size={15} /> Adicionar Grupo
          </button>
        </div>
      </div>

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px', marginBottom: '24px' }}>
        <StatCard icon={<Building2 size={18} />} label="Cidades" value={cities.length} color="#00e5ff" />
        <StatCard icon={<Tag size={18} />} label="Grupos Tagueados" value={groups.length} color="#b347ff" />
        <StatCard icon={<Send size={18} />} label="Broadcasts Enviados" value={broadcasts.length} color="#10f59b" />
      </div>

      {/* Search */}
      <div style={{ position: 'relative', marginBottom: '20px', maxWidth: '400px' }}>
        <Search size={16} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: '#6b7384' }} />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por cidade, grupo..."
          style={{ ...inputStyle, paddingLeft: '36px', width: '100%' }}
        />
      </div>

      {loading ? (
        <p style={{ color: '#6b7384', textAlign: 'center', padding: '40px' }}>Carregando...</p>
      ) : groups.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: '#6b7384' }}>
          <Building2 size={48} style={{ marginBottom: '16px', opacity: 0.3 }} />
          <p style={{ fontSize: '15px', margin: 0 }}>Nenhum grupo C-LEVEL cadastrado</p>
          <p style={{ fontSize: '13px', margin: '8px 0 0' }}>Adicione grupos do WhatsApp e associe a uma cidade</p>
        </div>
      ) : (
        Object.keys(groupsByCity).sort().map((city) => (
          <div key={city} style={{ marginBottom: '24px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
              <Building2 size={16} color="#00e5ff" />
              <h2 style={{ fontSize: '15px', fontWeight: 600, color: '#f4f6fb', margin: 0 }}>{city}</h2>
              <span style={{ fontSize: '11px', color: '#6b7384', background: 'rgba(255,255,255,0.06)', padding: '2px 8px', borderRadius: '10px' }}>
                {groupsByCity[city].length} grupo{groupsByCity[city].length !== 1 ? 's' : ''}
              </span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '10px' }}>
              {groupsByCity[city].map((g) => (
                <div key={g.id} style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: '12px', padding: '14px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontSize: '13.5px', fontWeight: 600, color: '#f4f6fb' }}>{g.contacts?.name ?? '(grupo removido)'}</div>
                    {g.label && <div style={{ fontSize: '11px', color: '#6b7384', marginTop: '2px' }}>{g.label}</div>}
                  </div>
                  <button onClick={() => setDeleteTarget(g)} style={{ background: 'none', border: 'none', color: '#ff4d79', cursor: 'pointer', padding: '6px' }}>
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        ))
      )}

      {/* Broadcast history */}
      {broadcasts.length > 0 && (
        <div style={{ marginTop: '32px' }}>
          <h2 style={{ fontSize: '15px', fontWeight: 600, color: '#f4f6fb', marginBottom: '12px' }}>Historico de Broadcasts</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {broadcasts.map((b) => (
              <div key={b.id} style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: '10px', padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                <div style={{ flex: 1, minWidth: '200px' }}>
                  <div style={{ fontSize: '13px', color: '#f4f6fb', whiteSpace: 'pre-wrap', maxHeight: '40px', overflow: 'hidden', textOverflow: 'ellipsis' }}>{b.message}</div>
                  <div style={{ fontSize: '11px', color: '#6b7384', marginTop: '4px' }}>
                    {b.cities.join(', ')} {b.deadline && `| Prazo: ${b.deadline}`}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '12px', color: b.status === 'sent' ? '#10f59b' : b.status === 'partial' ? '#ffb547' : '#ff4d79' }}>
                    {b.groups_sent}/{b.groups_targeted} enviados
                  </span>
                  {b.status === 'sent' ? <CheckCircle size={14} color="#10f59b" /> : <AlertCircle size={14} color={b.status === 'partial' ? '#ffb547' : '#ff4d79'} />}
                  <span style={{ fontSize: '11px', color: '#6b7384' }}>
                    {new Date(b.created_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Add Modal */}
      {addModalOpen && (
        <Overlay onClose={() => setAddModalOpen(false)} title="Adicionar Grupo C-LEVEL">
          <label style={labelStyle}>Grupo do WhatsApp *</label>
          <div style={{ position: 'relative', marginBottom: '4px' }}>
            <Search size={14} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: '#6b7384' }} />
            <input value={addSearch} onChange={(e) => setAddSearch(e.target.value)} placeholder="Buscar grupo..." style={{ ...inputStyle, paddingLeft: '32px', width: '100%', marginBottom: 0 }} />
          </div>
          <div style={{ maxHeight: '160px', overflowY: 'auto', marginBottom: '14px', border: `1px solid ${border}`, borderRadius: '8px' }}>
            {filteredAddContacts.length === 0 ? (
              <p style={{ color: '#6b7384', fontSize: '12px', padding: '12px', textAlign: 'center', margin: 0 }}>
                {availableContacts.length === 0 ? 'Todos os grupos ja foram adicionados' : 'Nenhum grupo encontrado'}
              </p>
            ) : filteredAddContacts.map((c) => (
              <div
                key={c.id}
                onClick={() => setAddContactId(c.id)}
                style={{
                  padding: '8px 12px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: addContactId === c.id ? '#00e5ff' : '#c6cdda',
                  background: addContactId === c.id ? 'rgba(0,229,255,0.08)' : 'transparent',
                  borderBottom: `1px solid ${border}`,
                }}
              >
                {c.name}
              </div>
            ))}
          </div>

          <label style={labelStyle}>Cidade *</label>
          <input value={addCity} onChange={(e) => setAddCity(e.target.value)} placeholder="Ex: Feira de Santana" style={{ ...inputStyle, width: '100%', marginBottom: '14px' }} list="city-suggestions" />
          <datalist id="city-suggestions">
            {cities.map((c) => <option key={c} value={c} />)}
          </datalist>

          <label style={labelStyle}>Label (opcional)</label>
          <input value={addLabel} onChange={(e) => setAddLabel(e.target.value)} placeholder="Descricao extra" style={{ ...inputStyle, width: '100%', marginBottom: '14px' }} />

          {error && <p style={{ color: '#ff4d79', fontSize: '12px', margin: '0 0 10px' }}>{error}</p>}

          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
            <button onClick={() => setAddModalOpen(false)} style={btnStyle('transparent', true)}>Cancelar</button>
            <button onClick={handleAdd} disabled={saving} style={btnStyle('#00e5ff')}>{saving ? 'Salvando...' : 'Adicionar'}</button>
          </div>
        </Overlay>
      )}

      {/* Broadcast Modal */}
      {broadcastOpen && (
        <Overlay onClose={() => setBroadcastOpen(false)} title="Broadcast C-LEVEL">
          <label style={labelStyle}>Selecione as cidades *</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '14px' }}>
            <button onClick={selectAllCities} style={{
              ...chipStyle,
              background: bcCities.length === cities.length ? 'rgba(179,71,255,0.15)' : 'rgba(255,255,255,0.04)',
              borderColor: bcCities.length === cities.length ? '#b347ff' : 'rgba(255,255,255,0.1)',
              color: bcCities.length === cities.length ? '#b347ff' : '#6b7384',
            }}>
              Todas ({cities.length})
            </button>
            {cities.map((city) => {
              const sel = bcCities.includes(city);
              return (
                <button key={city} onClick={() => toggleBcCity(city)} style={{
                  ...chipStyle,
                  background: sel ? 'rgba(0,229,255,0.1)' : 'rgba(255,255,255,0.04)',
                  borderColor: sel ? '#00e5ff' : 'rgba(255,255,255,0.1)',
                  color: sel ? '#00e5ff' : '#c6cdda',
                }}>
                  {city} ({groupsByCity[city]?.length ?? 0})
                </button>
              );
            })}
          </div>

          <label style={labelStyle}>Mensagem *</label>
          <textarea
            value={bcMessage}
            onChange={(e) => setBcMessage(e.target.value)}
            rows={5}
            placeholder="Digite a mensagem para enviar a todos os grupos C-LEVEL selecionados..."
            style={{ ...inputStyle, width: '100%', marginBottom: '14px', resize: 'vertical', fontFamily: 'inherit' }}
          />

          <label style={labelStyle}>Prazo (opcional)</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '14px' }}>
            <Clock size={16} color="#6b7384" />
            <input value={bcDeadline} onChange={(e) => setBcDeadline(e.target.value)} placeholder="Ex: 15/06/2026 ou ate sexta-feira" style={{ ...inputStyle, flex: 1, marginBottom: 0 }} />
          </div>

          <p style={{ fontSize: '12px', color: '#6b7384', margin: '0 0 14px' }}>
            {bcCities.length > 0
              ? `Sera enviado para ${bcCities.reduce((acc, c) => acc + (groupsByCity[c]?.length ?? 0), 0)} grupo(s) em ${bcCities.length} cidade(s)`
              : 'Selecione ao menos uma cidade'
            }
          </p>

          {bcError && <p style={{ color: '#ff4d79', fontSize: '12px', margin: '0 0 10px' }}>{bcError}</p>}
          {bcResult && (
            <div style={{ background: 'rgba(16,245,155,0.06)', border: '1px solid rgba(16,245,155,0.2)', borderRadius: '8px', padding: '10px 14px', marginBottom: '14px', fontSize: '13px', color: '#10f59b' }}>
              Broadcast enviado: {bcResult.sent}/{bcResult.total} grupos receberam a mensagem.
            </div>
          )}

          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
            <button onClick={() => setBroadcastOpen(false)} style={btnStyle('transparent', true)}>Cancelar</button>
            <button onClick={handleBroadcast} disabled={bcSending} style={btnStyle('#b347ff')}>
              <Send size={14} /> {bcSending ? 'Enviando...' : 'Enviar Broadcast'}
            </button>
          </div>
        </Overlay>
      )}

      {/* Delete confirm */}
      {deleteTarget && (
        <Overlay onClose={() => setDeleteTarget(null)} title="Remover Grupo C-LEVEL">
          <p style={{ color: '#c6cdda', fontSize: '13px', margin: '0 0 16px' }}>
            Remover <strong>{deleteTarget.contacts?.name}</strong> ({deleteTarget.city}) da lista C-LEVEL?
          </p>
          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
            <button onClick={() => setDeleteTarget(null)} style={btnStyle('transparent', true)}>Cancelar</button>
            <button onClick={handleDelete} style={btnStyle('#ff4d79')}>Remover</button>
          </div>
        </Overlay>
      )}
    </div>
  );
}

function StatCard({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: number; color: string }) {
  return (
    <div style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: '12px', padding: '16px', display: 'flex', alignItems: 'center', gap: '12px' }}>
      <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: `${color}12`, display: 'flex', alignItems: 'center', justifyContent: 'center', color }}>{icon}</div>
      <div>
        <div style={{ fontSize: '20px', fontWeight: 700, color: '#f4f6fb' }}>{value}</div>
        <div style={{ fontSize: '11px', color: '#6b7384' }}>{label}</div>
      </div>
    </div>
  );
}

function Overlay({ onClose, title, children }: { onClose: () => void; title: string; children: React.ReactNode }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '16px' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#12141a', border: `1px solid ${border}`, borderRadius: '16px', padding: '24px', width: '100%', maxWidth: '500px', maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <h2 style={{ fontSize: '17px', fontWeight: 700, color: '#f4f6fb', margin: 0 }}>{title}</h2>
          <button onClick={onClose} style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', color: '#c6cdda', cursor: 'pointer', padding: '5px', display: 'flex' }}>
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function btnStyle(bg: string, ghost = false): React.CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '8px 16px', borderRadius: '10px', border: ghost ? '1px solid rgba(255,255,255,0.1)' : 'none',
    background: ghost ? 'transparent' : bg, color: ghost ? '#c6cdda' : bg === '#00e5ff' || bg === '#10f59b' ? '#07080c' : '#fff',
    fontSize: '13px', fontWeight: 600, cursor: 'pointer', transition: 'all 0.15s',
  };
}

const inputStyle: React.CSSProperties = {
  background: inputBg, border: `1px solid ${border}`, borderRadius: '8px', padding: '9px 12px', color: '#f4f6fb', fontSize: '13px', outline: 'none',
};

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: '12px', fontWeight: 600, color: '#6b7384', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.6px',
};

const chipStyle: React.CSSProperties = {
  padding: '5px 12px', borderRadius: '20px', fontSize: '12px', fontWeight: 500, cursor: 'pointer', border: '1px solid', transition: 'all 0.15s',
};
