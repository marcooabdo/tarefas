import { useEffect, useState } from 'react';
import { Plus, Search, CreditCard as Edit, Trash2, Power, X, Phone, Download, Users, RefreshCw, Check } from 'lucide-react';
import { supabase } from '../lib/supabase';
import type { Contact } from '../lib/types';
import { COUNTRY_CODES } from '../lib/types';
import { validateInternationalPhone, formatPhoneNumber } from '../lib/phoneUtils';

interface ContactFormState {
  name: string;
  localPhone: string;
  country_code: string;
  department: string;
}

const emptyForm: ContactFormState = { name: '', localPhone: '', country_code: '+55', department: '' };

interface ImportItem {
  remote_jid: string;
  name: string;
  phone: string;
  is_group: boolean;
  already_imported?: boolean;
}

export function Contacts() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editContact, setEditContact] = useState<Contact | null>(null);
  const [form, setForm] = useState<ContactFormState>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [phoneError, setPhoneError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Contact | null>(null);
  const [search, setSearch] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [importLoading, setImportLoading] = useState(false);
  const [importItems, setImportItems] = useState<ImportItem[]>([]);
  const [importError, setImportError] = useState('');
  const [selectedJids, setSelectedJids] = useState<Set<string>>(new Set());
  const [importSearch, setImportSearch] = useState('');
  const [importFilter, setImportFilter] = useState<'all' | 'groups' | 'contacts'>('all');
  const [importing, setImporting] = useState(false);

  useEffect(() => { loadContacts(); }, []);

  async function loadContacts() {
    setLoading(true);
    const { data } = await supabase.from('contacts').select('*').order('created_at', { ascending: false });
    setContacts((data as Contact[]) ?? []);
    setLoading(false);
  }

  function openCreate() {
    setEditContact(null);
    setForm(emptyForm);
    setError(''); setPhoneError('');
    setModalOpen(true);
  }

  function openEdit(c: Contact) {
    setEditContact(c);
    const localPhone = c.phone.replace(c.country_code, '');
    setForm({ name: c.name, localPhone, country_code: c.country_code, department: c.department });
    setError(''); setPhoneError('');
    setModalOpen(true);
  }

  function validateForm(): boolean {
    if (!form.name.trim()) { setError('O nome é obrigatório.'); return false; }
    if (!form.localPhone.trim()) { setPhoneError('O telefone é obrigatório.'); return false; }
    const fullPhone = formatPhoneNumber(form.country_code, form.localPhone);
    if (!validateInternationalPhone(fullPhone)) {
      setPhoneError('Número inválido. Use o formato internacional (ex: 11999999999).');
      return false;
    }
    return true;
  }

  async function handleSave() {
    setError(''); setPhoneError('');
    if (!validateForm()) return;
    setSaving(true);
    const phone = formatPhoneNumber(form.country_code, form.localPhone);
    const payload = {
      name: form.name.trim(), phone,
      country_code: form.country_code,
      department: form.department.trim(),
      updated_at: new Date().toISOString(),
    };
    try {
      if (editContact) await supabase.from('contacts').update(payload).eq('id', editContact.id);
      else await supabase.from('contacts').insert(payload);
      setModalOpen(false);
      await loadContacts();
    } catch {
      setError('Erro ao salvar contato. Tente novamente.');
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleActive(contact: Contact) {
    await supabase.from('contacts').update({ active: !contact.active, updated_at: new Date().toISOString() }).eq('id', contact.id);
    await loadContacts();
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    await supabase.from('contacts').delete().eq('id', deleteTarget.id);
    setDeleteTarget(null);
    await loadContacts();
  }

  async function openImport() {
    setImportOpen(true);
    setImportError('');
    setSelectedJids(new Set());
    setImportSearch('');
    setImportFilter('all');
    await loadWhatsAppList();
  }

  async function loadWhatsAppList() {
    setImportLoading(true);
    setImportError('');
    try {
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/fetch-whatsapp-chats`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ action: 'list' }),
      });
      const data = await res.json();
      if (!res.ok) {
        setImportError(data.error ?? 'Erro ao buscar grupos/contatos do WhatsApp.');
        setImportItems([]);
      } else {
        setImportItems(data.items ?? []);
      }
    } catch (e) {
      setImportError('Falha de conexão com a Evolution API.');
      setImportItems([]);
    } finally {
      setImportLoading(false);
    }
  }

  function toggleJid(jid: string) {
    setSelectedJids((prev) => {
      const next = new Set(prev);
      if (next.has(jid)) next.delete(jid);
      else next.add(jid);
      return next;
    });
  }

  async function handleImport() {
    const items = importItems.filter((i) => selectedJids.has(i.remote_jid));
    if (items.length === 0) return;
    setImporting(true);
    setImportError('');
    try {
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/fetch-whatsapp-chats`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ action: 'import', items }),
      });
      const data = await res.json();
      if (!res.ok) {
        setImportError(data.error ?? 'Erro ao importar contatos.');
        return;
      }
      setImportOpen(false);
      await loadContacts();
    } catch (e) {
      setImportError('Falha de conexão ao importar.');
    } finally {
      setImporting(false);
    }
  }

  const filteredImportItems = importItems.filter((it) => {
    if (importFilter === 'groups' && !it.is_group) return false;
    if (importFilter === 'contacts' && it.is_group) return false;
    if (!importSearch.trim()) return true;
    const q = importSearch.toLowerCase();
    return it.name.toLowerCase().includes(q) || it.phone.includes(importSearch);
  });

  const filtered = contacts.filter(
    (c) =>
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.phone.includes(search) ||
      c.department.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div style={{ padding: '32px 36px', maxWidth: '1400px', margin: '0 auto' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '24px', flexWrap: 'wrap', gap: '16px' }}>
        <div>
          <div style={{ fontSize: '11px', color: '#6b7384', letterSpacing: '2px', textTransform: 'uppercase', fontWeight: 600, marginBottom: '6px' }}>
            Diretório
          </div>
          <h1 style={{ fontSize: '32px', fontWeight: 700, color: '#f4f6fb', margin: 0, letterSpacing: '-0.5px' }}>
            Contatos
          </h1>
          <p style={{ color: '#9aa3b2', margin: '6px 0 0', fontSize: '14px' }}>
            Gerencie os destinatários das mensagens automáticas.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          <button className="ghost-btn" onClick={openImport}>
            <Download size={14} /> Importar do WhatsApp
          </button>
          <button className="neon-btn" onClick={openCreate}>
            <Plus size={14} /> Novo Contato
          </button>
        </div>
      </header>

      <div className="glass" style={{ padding: '0', overflow: 'hidden' }}>
        <div style={{ padding: '16px 18px', borderBottom: '1px solid rgba(255,255,255,0.06)', position: 'relative' }}>
          <Search size={14} color="#6b7384" style={{ position: 'absolute', left: '30px', top: '50%', transform: 'translateY(-50%)' }} />
          <input
            className="nx-input"
            placeholder="Buscar por nome, telefone ou setor..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ maxWidth: '360px', paddingLeft: '36px' }}
          />
        </div>

        {loading ? (
          <div style={{ padding: '60px', textAlign: 'center', color: '#6b7384' }}>Carregando...</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: '60px', textAlign: 'center', color: '#6b7384', fontSize: '13px' }}>
            {search ? 'Nenhum contato encontrado para a busca.' : 'Nenhum contato cadastrado ainda.'}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'rgba(255,255,255,0.03)' }}>
                  {['Nome', 'Telefone', 'Setor/Cargo', 'Status', 'Criado em', 'Ações'].map((col) => (
                    <th key={col} style={{ padding: '12px 16px', textAlign: 'left', fontSize: '11px', color: '#6b7384', fontWeight: 600, letterSpacing: '0.6px', textTransform: 'uppercase' }}>{col}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => (
                  <tr key={c.id} style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                    <td style={{ padding: '14px 16px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <div style={{
                          width: '34px', height: '34px', borderRadius: '50%',
                          background: c.is_group
                            ? 'linear-gradient(135deg, rgba(16,245,155,0.2), rgba(0,229,255,0.2))'
                            : 'linear-gradient(135deg, rgba(0,229,255,0.2), rgba(179,71,255,0.2))',
                          border: `1px solid ${c.is_group ? 'rgba(16,245,155,0.3)' : 'rgba(0,229,255,0.3)'}`,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          color: c.is_group ? '#10f59b' : '#00e5ff', fontWeight: 700, fontSize: '13px', flexShrink: 0,
                        }}>
                          {c.is_group ? <Users size={14} /> : c.name.charAt(0).toUpperCase()}
                        </div>
                        <span style={{ fontSize: '13px', fontWeight: 500, color: '#f4f6fb', display: 'flex', alignItems: 'center', gap: '6px' }}>
                          {c.name}
                          {c.is_group && (
                            <span style={{ fontSize: '9.5px', color: '#10f59b', fontWeight: 700, padding: '1px 5px', borderRadius: '4px', background: 'rgba(16,245,155,0.1)', border: '1px solid rgba(16,245,155,0.3)' }}>GRUPO</span>
                          )}
                        </span>
                      </div>
                    </td>
                    <td style={{ padding: '14px 16px', fontSize: '12px', color: '#c6cdda', fontFamily: 'monospace' }}>{c.phone}</td>
                    <td style={{ padding: '14px 16px', fontSize: '12.5px', color: '#9aa3b2' }}>{c.department || '—'}</td>
                    <td style={{ padding: '14px 16px' }}>
                      <span className="chip" style={{
                        background: c.active ? 'rgba(16,245,155,0.12)' : 'rgba(255,77,121,0.12)',
                        color: c.active ? '#10f59b' : '#ff4d79',
                        border: `1px solid ${c.active ? 'rgba(16,245,155,0.3)' : 'rgba(255,77,121,0.3)'}`,
                      }}>
                        {c.active ? 'Ativo' : 'Inativo'}
                      </span>
                    </td>
                    <td style={{ padding: '14px 16px', fontSize: '11.5px', color: '#6b7384' }}>
                      {new Date(c.created_at).toLocaleDateString('pt-BR')}
                    </td>
                    <td style={{ padding: '14px 16px' }}>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <button className="ghost-btn" onClick={() => openEdit(c)} aria-label="Editar" style={{ padding: '6px 8px' }}>
                          <Edit size={13} />
                        </button>
                        <button className="ghost-btn" onClick={() => handleToggleActive(c)} aria-label={c.active ? 'Desativar' : 'Ativar'} style={{ padding: '6px 8px' }}>
                          <Power size={13} />
                        </button>
                        <button className="ghost-btn" onClick={() => setDeleteTarget(c)} aria-label="Excluir" style={{ padding: '6px 8px', color: '#ff4d79' }}>
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modalOpen && (
        <Modal onClose={() => setModalOpen(false)} title={editContact ? 'Editar Contato' : 'Novo Contato'}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            {error && <ErrorBar message={error} />}
            <Field label="Nome completo">
              <input className="nx-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: '12px' }}>
              <Field label="País">
                <select className="nx-input" value={form.country_code} onChange={(e) => setForm({ ...form, country_code: e.target.value })}>
                  {COUNTRY_CODES.map((cc) => (
                    <option key={cc.value} value={cc.value} style={{ background: '#0e1016' }}>{cc.label}</option>
                  ))}
                </select>
              </Field>
              <Field label="Telefone">
                <input
                  className="nx-input"
                  placeholder="11999999999"
                  value={form.localPhone}
                  onChange={(e) => setForm({ ...form, localPhone: e.target.value })}
                  style={phoneError ? { borderColor: '#ff4d79' } : undefined}
                />
                {phoneError && <span style={{ fontSize: '11px', color: '#ff4d79' }}>{phoneError}</span>}
              </Field>
            </div>
            <Field label="Setor / Cargo">
              <input className="nx-input" placeholder="Ex: Comercial, Financeiro..." value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} />
            </Field>
            <div style={{
              padding: '10px 12px', borderRadius: '8px',
              background: 'rgba(0,229,255,0.05)', border: '1px solid rgba(0,229,255,0.2)',
              fontSize: '12px', color: '#9aa3b2',
            }}>
              <Phone size={11} style={{ marginRight: '6px', verticalAlign: '-1px' }} />
              O número será formatado como:{' '}
              <strong style={{ color: '#00e5ff', fontFamily: 'monospace' }}>
                {form.country_code}{form.localPhone.replace(/\D/g, '')}
              </strong>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '22px' }}>
            <button className="ghost-btn" onClick={() => setModalOpen(false)}>Cancelar</button>
            <button className="neon-btn" disabled={saving} onClick={handleSave}>
              {saving ? 'Salvando...' : editContact ? 'Salvar Alterações' : 'Criar Contato'}
            </button>
          </div>
        </Modal>
      )}

      {importOpen && (
        <div onClick={() => setImportOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(4,5,9,0.75)', backdropFilter: 'blur(6px)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
          <div onClick={(e) => e.stopPropagation()} className="glass" style={{ width: '100%', maxWidth: '640px', padding: '26px', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
              <div>
                <h2 style={{ fontSize: '18px', fontWeight: 700, color: '#f4f6fb', margin: 0 }}>Importar do WhatsApp</h2>
                <p style={{ fontSize: '12px', color: '#9aa3b2', margin: '4px 0 0' }}>
                  Grupos e conversas existentes na instância conectada.
                </p>
              </div>
              <button onClick={() => setImportOpen(false)} className="ghost-btn" style={{ padding: '6px' }}><X size={15} /></button>
            </div>

            {importError && <ErrorBar message={importError} />}

            <div style={{ display: 'flex', gap: '8px', marginBottom: '10px', marginTop: importError ? '10px' : 0, flexWrap: 'wrap' }}>
              {(['all', 'groups', 'contacts'] as const).map((f) => {
                const active = importFilter === f;
                return (
                  <button
                    key={f}
                    onClick={() => setImportFilter(f)}
                    style={{
                      padding: '6px 12px', borderRadius: '20px',
                      border: `1px solid ${active ? 'rgba(0,229,255,0.5)' : 'rgba(255,255,255,0.08)'}`,
                      background: active ? 'rgba(0,229,255,0.12)' : 'transparent',
                      color: active ? '#00e5ff' : '#9aa3b2',
                      fontSize: '11.5px', fontWeight: 600, cursor: 'pointer',
                    }}
                  >
                    {f === 'all' ? 'Todos' : f === 'groups' ? 'Grupos' : 'Contatos'}
                  </button>
                );
              })}
              <button className="ghost-btn" onClick={loadWhatsAppList} style={{ marginLeft: 'auto', padding: '6px 12px' }} disabled={importLoading}>
                <RefreshCw size={12} /> Atualizar
              </button>
            </div>

            <div style={{ position: 'relative', marginBottom: '10px' }}>
              <Search size={13} color="#6b7384" style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)' }} />
              <input
                className="nx-input"
                placeholder="Buscar..."
                value={importSearch}
                onChange={(e) => setImportSearch(e.target.value)}
                style={{ paddingLeft: '34px' }}
              />
            </div>

            <div style={{ flex: 1, overflowY: 'auto', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px', background: 'rgba(0,0,0,0.2)', minHeight: '200px' }}>
              {importLoading ? (
                <div style={{ padding: '50px', textAlign: 'center', color: '#6b7384', fontSize: '13px' }}>Conectando à Evolution API...</div>
              ) : filteredImportItems.length === 0 ? (
                <div style={{ padding: '50px', textAlign: 'center', color: '#6b7384', fontSize: '13px' }}>
                  {importItems.length === 0 ? 'Nenhum grupo ou conversa encontrada.' : 'Nenhum item corresponde à busca.'}
                </div>
              ) : (
                filteredImportItems.map((it, idx) => {
                  const selected = selectedJids.has(it.remote_jid);
                  const disabled = it.already_imported;
                  return (
                    <div
                      key={it.remote_jid}
                      onClick={() => !disabled && toggleJid(it.remote_jid)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: '12px',
                        padding: '10px 14px',
                        borderTop: idx === 0 ? 'none' : '1px solid rgba(255,255,255,0.04)',
                        cursor: disabled ? 'not-allowed' : 'pointer',
                        background: selected ? 'rgba(0,229,255,0.06)' : 'transparent',
                        opacity: disabled ? 0.5 : 1,
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
                        width: '34px', height: '34px', borderRadius: '50%',
                        background: it.is_group ? 'linear-gradient(135deg, rgba(16,245,155,0.2), rgba(0,229,255,0.2))' : 'linear-gradient(135deg, rgba(0,229,255,0.2), rgba(179,71,255,0.2))',
                        border: `1px solid ${it.is_group ? 'rgba(16,245,155,0.3)' : 'rgba(0,229,255,0.3)'}`,
                        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                        color: it.is_group ? '#10f59b' : '#00e5ff',
                      }}>
                        {it.is_group ? <Users size={15} /> : <span style={{ fontWeight: 700, fontSize: '13px' }}>{it.name.charAt(0).toUpperCase()}</span>}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: '13px', fontWeight: 600, color: '#f4f6fb', display: 'flex', alignItems: 'center', gap: '6px' }}>
                          {it.name}
                          {it.is_group && (
                            <span style={{ fontSize: '10px', color: '#10f59b', fontWeight: 700, padding: '1px 5px', borderRadius: '4px', background: 'rgba(16,245,155,0.1)', border: '1px solid rgba(16,245,155,0.3)' }}>GRUPO</span>
                          )}
                        </div>
                        <div style={{ fontSize: '11px', color: '#6b7384', fontFamily: 'monospace' }}>
                          {it.is_group ? it.remote_jid : (it.phone || '—')}
                        </div>
                      </div>
                      {disabled && (
                        <span style={{ fontSize: '10.5px', color: '#6b7384', fontWeight: 600, padding: '2px 7px', borderRadius: '4px', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>Já importado</span>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            <div style={{ fontSize: '11px', color: '#6b7384', marginTop: '10px' }}>
              {selectedJids.size} item(ns) selecionado(s). Grupos são importados com o JID do WhatsApp como identificador.
            </div>

            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '16px' }}>
              <button className="ghost-btn" onClick={() => setImportOpen(false)}>Cancelar</button>
              <button className="neon-btn" disabled={selectedJids.size === 0 || importing} onClick={handleImport}>
                <Download size={13} /> {importing ? 'Importando...' : `Importar ${selectedJids.size || ''}`.trim()}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <Modal onClose={() => setDeleteTarget(null)} title="Confirmar Exclusão">
          <p style={{ color: '#c6cdda', fontSize: '13.5px', lineHeight: 1.6, margin: 0 }}>
            Tem certeza que deseja excluir o contato <strong style={{ color: '#f4f6fb' }}>{deleteTarget.name}</strong>? Esta ação não pode ser desfeita.
          </p>
          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '22px' }}>
            <button className="ghost-btn" onClick={() => setDeleteTarget(null)}>Cancelar</button>
            <button className="neon-btn" style={{ background: 'linear-gradient(135deg, #ff4d79, #b347ff)' }} onClick={handleDelete}>Excluir</button>
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

function ErrorBar({ message }: { message: string }) {
  return (
    <div style={{
      padding: '10px 14px', borderRadius: '10px',
      background: 'rgba(255,77,121,0.08)', border: '1px solid rgba(255,77,121,0.35)',
      color: '#ff4d79', fontSize: '12.5px',
    }}>
      {message}
    </div>
  );
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(4,5,9,0.75)',
        backdropFilter: 'blur(6px)', zIndex: 100,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="glass"
        style={{ width: '100%', maxWidth: '520px', padding: '26px', maxHeight: '90vh', overflowY: 'auto' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '18px' }}>
          <h2 style={{ fontSize: '18px', fontWeight: 700, color: '#f4f6fb', margin: 0 }}>{title}</h2>
          <button onClick={onClose} className="ghost-btn" style={{ padding: '6px' }}><X size={15} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}
