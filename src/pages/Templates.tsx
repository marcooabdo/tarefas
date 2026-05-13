import { useEffect, useState } from 'react';
import { Plus, CreditCard as Edit, Trash2, Eye, X, MessageSquare } from 'lucide-react';
import { supabase } from '../lib/supabase';
import type { MessageTemplate } from '../lib/types';
import { extractVariables } from '../lib/phoneUtils';

interface TemplateForm {
  name: string;
  content: string;
}

const emptyForm: TemplateForm = { name: '', content: '' };
const VARIABLE_HINTS = ['{nome}', '{saudacao}', '{setor}', '{data}', '{hora}'];

export function Templates() {
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editTemplate, setEditTemplate] = useState<MessageTemplate | null>(null);
  const [form, setForm] = useState<TemplateForm>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<MessageTemplate | null>(null);
  const [previewTemplate, setPreviewTemplate] = useState<MessageTemplate | null>(null);

  useEffect(() => { loadTemplates(); }, []);

  async function loadTemplates() {
    setLoading(true);
    const { data } = await supabase.from('message_templates').select('*').order('created_at', { ascending: false });
    setTemplates((data as MessageTemplate[]) ?? []);
    setLoading(false);
  }

  function openCreate() {
    setEditTemplate(null); setForm(emptyForm); setError(''); setModalOpen(true);
  }

  function openEdit(t: MessageTemplate) {
    setEditTemplate(t); setForm({ name: t.name, content: t.content }); setError(''); setModalOpen(true);
  }

  async function handleSave() {
    setError('');
    if (!form.name.trim()) { setError('O nome do template é obrigatório.'); return; }
    if (!form.content.trim()) { setError('O conteúdo da mensagem é obrigatório.'); return; }
    setSaving(true);
    const variables = extractVariables(form.content);
    const payload = { name: form.name.trim(), content: form.content.trim(), variables, updated_at: new Date().toISOString() };
    try {
      if (editTemplate) await supabase.from('message_templates').update(payload).eq('id', editTemplate.id);
      else await supabase.from('message_templates').insert(payload);
      setModalOpen(false);
      await loadTemplates();
    } catch {
      setError('Erro ao salvar template.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    await supabase.from('message_templates').delete().eq('id', deleteTarget.id);
    setDeleteTarget(null);
    await loadTemplates();
  }

  function insertVariable(v: string) {
    setForm((prev) => ({ ...prev, content: prev.content + v }));
  }

  const detectedVars = extractVariables(form.content);

  return (
    <div style={{ padding: '32px 36px', maxWidth: '1400px', margin: '0 auto' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '24px', flexWrap: 'wrap', gap: '16px' }}>
        <div>
          <div style={{ fontSize: '11px', color: '#6b7384', letterSpacing: '2px', textTransform: 'uppercase', fontWeight: 600, marginBottom: '6px' }}>
            Biblioteca
          </div>
          <h1 style={{ fontSize: '32px', fontWeight: 700, color: '#f4f6fb', margin: 0, letterSpacing: '-0.5px' }}>
            Templates de Mensagens
          </h1>
          <p style={{ color: '#9aa3b2', margin: '6px 0 0', fontSize: '14px' }}>
            Modelos reutilizáveis com variáveis dinâmicas ({'{nome}'}, {'{saudacao}'}, etc).
          </p>
        </div>
        <button className="neon-btn" onClick={openCreate}>
          <Plus size={14} /> Novo Template
        </button>
      </header>

      {loading ? (
        <div className="glass" style={{ padding: '60px', textAlign: 'center', color: '#6b7384' }}>Carregando...</div>
      ) : templates.length === 0 ? (
        <div className="glass" style={{ padding: '80px', textAlign: 'center', color: '#6b7384', fontSize: '13px' }}>
          Nenhum template cadastrado. Crie seu primeiro template de mensagem.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '16px' }}>
          {templates.map((t) => (
            <div key={t.id} className="glass" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div style={{ padding: '18px 20px', flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                  <span style={{ fontSize: '15px', fontWeight: 600, color: '#f4f6fb' }}>{t.name}</span>
                  <span className="chip" style={{
                    background: t.active ? 'rgba(16,245,155,0.12)' : 'rgba(255,77,121,0.12)',
                    color: t.active ? '#10f59b' : '#ff4d79',
                    border: `1px solid ${t.active ? 'rgba(16,245,155,0.3)' : 'rgba(255,77,121,0.3)'}`,
                  }}>
                    {t.active ? 'Ativo' : 'Inativo'}
                  </span>
                </div>
                <div style={{
                  fontSize: '12.5px', color: '#c6cdda', lineHeight: 1.6,
                  background: 'rgba(255,255,255,0.03)',
                  border: '1px solid rgba(255,255,255,0.05)',
                  padding: '10px 12px', borderRadius: '8px',
                  whiteSpace: 'pre-wrap', maxHeight: '92px', overflow: 'hidden', position: 'relative',
                }}>
                  {t.content}
                </div>
                {t.variables.length > 0 && (
                  <div style={{ marginTop: '12px', display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                    {t.variables.map((v) => (
                      <span key={v} style={{
                        fontSize: '11px', fontFamily: 'monospace',
                        background: 'rgba(0,229,255,0.1)', color: '#00e5ff',
                        border: '1px solid rgba(0,229,255,0.3)',
                        padding: '2px 8px', borderRadius: '4px',
                      }}>
                        {`{${v}}`}
                      </span>
                    ))}
                  </div>
                )}
                <div style={{ marginTop: '10px', fontSize: '11px', color: '#6b7384' }}>
                  Criado em {new Date(t.created_at).toLocaleDateString('pt-BR')}
                </div>
              </div>
              <div style={{ padding: '10px 14px', display: 'flex', gap: '6px', justifyContent: 'flex-end', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                <button className="ghost-btn" onClick={() => setPreviewTemplate(t)} aria-label="Ver" style={{ padding: '6px 8px' }}>
                  <Eye size={13} />
                </button>
                <button className="ghost-btn" onClick={() => openEdit(t)} aria-label="Editar" style={{ padding: '6px 8px' }}>
                  <Edit size={13} />
                </button>
                <button className="ghost-btn" onClick={() => setDeleteTarget(t)} aria-label="Excluir" style={{ padding: '6px 8px', color: '#ff4d79' }}>
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {modalOpen && (
        <Modal onClose={() => setModalOpen(false)} title={editTemplate ? 'Editar Template' : 'Novo Template'} width={560}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            {error && (
              <div style={{
                padding: '10px 14px', borderRadius: '10px',
                background: 'rgba(255,77,121,0.08)', border: '1px solid rgba(255,77,121,0.35)',
                color: '#ff4d79', fontSize: '12.5px',
              }}>{error}</div>
            )}
            <Field label="Nome do Template">
              <input
                className="nx-input"
                placeholder="Ex: Cobrança de Relatório Diário"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </Field>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px', gap: '8px', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '11px', color: '#9aa3b2', fontWeight: 600, letterSpacing: '0.4px', textTransform: 'uppercase' }}>
                  Conteúdo da Mensagem
                </span>
                <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                  {VARIABLE_HINTS.map((v) => (
                    <button
                      key={v}
                      onClick={() => insertVariable(v)}
                      style={{
                        fontSize: '11px', fontFamily: 'monospace',
                        background: 'rgba(0,229,255,0.08)', color: '#00e5ff',
                        padding: '3px 8px', borderRadius: '4px',
                        border: '1px solid rgba(0,229,255,0.3)', cursor: 'pointer',
                      }}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </div>
              <textarea
                className="nx-input"
                rows={7}
                placeholder={`{saudacao}, {nome}!\n\nPor favor, envie seu relatório diário até as 18h.\n\nObrigado!`}
                value={form.content}
                onChange={(e) => setForm({ ...form, content: e.target.value })}
                style={{ fontFamily: 'inherit', lineHeight: 1.6, resize: 'vertical' }}
              />
            </div>
            {detectedVars.length > 0 && (
              <div style={{
                padding: '10px 12px', borderRadius: '8px',
                background: 'rgba(16,245,155,0.05)', border: '1px solid rgba(16,245,155,0.25)',
                fontSize: '12px', color: '#c6cdda',
              }}>
                Variáveis detectadas:{' '}
                {detectedVars.map((v) => (
                  <strong key={v} style={{ color: '#10f59b', marginLeft: '4px', fontFamily: 'monospace' }}>
                    {`{${v}}`}
                  </strong>
                ))}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '22px' }}>
            <button className="ghost-btn" onClick={() => setModalOpen(false)}>Cancelar</button>
            <button className="neon-btn" disabled={saving} onClick={handleSave}>
              {saving ? 'Salvando...' : editTemplate ? 'Salvar Alterações' : 'Criar Template'}
            </button>
          </div>
        </Modal>
      )}

      {previewTemplate && (
        <Modal onClose={() => setPreviewTemplate(null)} title={previewTemplate.name} width={440}>
          <div>
            <div style={{
              display: 'flex', alignItems: 'center', gap: '8px',
              fontSize: '11px', color: '#6b7384', marginBottom: '10px',
              fontWeight: 600, letterSpacing: '0.4px', textTransform: 'uppercase',
            }}>
              <MessageSquare size={12} /> Prévia
            </div>
            <div style={{
              background: 'rgba(16,245,155,0.08)',
              border: '1px solid rgba(16,245,155,0.25)',
              borderRadius: '12px 12px 2px 12px',
              padding: '14px 16px', fontSize: '14px', lineHeight: 1.6,
              color: '#e4f6ec', whiteSpace: 'pre-wrap',
              maxWidth: '340px', marginLeft: 'auto',
            }}>
              {previewTemplate.content}
            </div>
            {previewTemplate.variables.length > 0 && (
              <div style={{ marginTop: '16px' }}>
                <div style={{ fontSize: '11px', color: '#6b7384', fontWeight: 600, letterSpacing: '0.4px', textTransform: 'uppercase', marginBottom: '6px' }}>
                  Variáveis substituídas no envio
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px' }}>
                  {previewTemplate.variables.map((v) => (
                    <span key={v} style={{
                      fontSize: '11px', fontFamily: 'monospace',
                      background: 'rgba(0,229,255,0.1)', color: '#00e5ff',
                      border: '1px solid rgba(0,229,255,0.3)',
                      padding: '3px 8px', borderRadius: '4px',
                    }}>
                      {`{${v}}`}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '22px' }}>
            <button className="ghost-btn" onClick={() => setPreviewTemplate(null)}>Fechar</button>
          </div>
        </Modal>
      )}

      {deleteTarget && (
        <Modal onClose={() => setDeleteTarget(null)} title="Confirmar Exclusão">
          <p style={{ color: '#c6cdda', fontSize: '13.5px', lineHeight: 1.6, margin: 0 }}>
            Tem certeza que deseja excluir o template <strong style={{ color: '#f4f6fb' }}>{deleteTarget.name}</strong>? Esta ação não pode ser desfeita.
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
