import { useEffect, useMemo, useState } from 'react';
import {
  BarChart, Bar, CartesianGrid, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from 'recharts';
import { Download, FileText, Trophy, Zap, TrendingUp, Users as Users2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import type { Task } from '../lib/types';

interface Row {
  name: string;
  total: number;
  completed: number;
  overdue: number;
  nudges: number;
  rate: number;
}

export function Reports() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    const { data } = await supabase.from('tasks').select('*');
    setTasks((data as Task[]) ?? []);
    setLoading(false);
  }

  const rows = useMemo<Row[]>(() => {
    const map = new Map<string, Row>();
    const now = Date.now();
    tasks.forEach((t) => {
      const r = map.get(t.assignee_name) ?? {
        name: t.assignee_name, total: 0, completed: 0, overdue: 0, nudges: 0, rate: 0,
      };
      r.total += 1;
      if (t.status === 'completed') r.completed += 1;
      if (t.status !== 'completed' && t.due_date && new Date(t.due_date).getTime() < now) r.overdue += 1;
      r.nudges += t.ai_interventions;
      map.set(t.assignee_name, r);
    });
    const arr = Array.from(map.values()).map((r) => ({
      ...r, rate: r.total ? Math.round((r.completed / r.total) * 100) : 0,
    }));
    return arr.sort((a, b) => b.rate - a.rate);
  }, [tasks]);

  const topPerformer = rows[0];
  const mostNudged = useMemo(
    () => [...rows].sort((a, b) => b.nudges - a.nudges)[0],
    [rows]
  );
  const teamRate = useMemo(() => {
    if (!tasks.length) return 0;
    const done = tasks.filter((t) => t.status === 'completed').length;
    return Math.round((done / tasks.length) * 100);
  }, [tasks]);

  function exportCSV() {
    const header = ['Responsável', 'Total', 'Concluídas', 'Atrasadas', 'Cobranças IA', 'Taxa %'];
    const lines = [header.join(',')].concat(
      rows.map((r) => [r.name, r.total, r.completed, r.overdue, r.nudges, r.rate].join(','))
    );
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `relatorio-equipe-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportPDF() {
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Relatório da Equipe</title>
      <style>body{font-family:Arial,sans-serif;padding:32px;color:#111}h1{margin:0 0 8px}table{width:100%;border-collapse:collapse;margin-top:16px}th,td{padding:10px;border-bottom:1px solid #ddd;text-align:left;font-size:13px}th{background:#f4f4f4}</style>
      </head><body>
      <h1>Relatório de Performance</h1>
      <p>Gerado em ${new Date().toLocaleString('pt-BR')}</p>
      <table><thead><tr><th>Responsável</th><th>Total</th><th>Concluídas</th><th>Atrasadas</th><th>Cobranças IA</th><th>Taxa</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${r.name}</td><td>${r.total}</td><td>${r.completed}</td><td>${r.overdue}</td><td>${r.nudges}</td><td>${r.rate}%</td></tr>`).join('')}
      </tbody></table>
      <script>window.onload=()=>window.print();</script>
      </body></html>`;
    const w = window.open('', '_blank');
    if (w) { w.document.write(html); w.document.close(); }
  }

  if (loading) {
    return <div style={{ padding: '60px', textAlign: 'center', color: '#6b7384' }}>Carregando relatórios...</div>;
  }

  const barColors = ['#00e5ff', '#10f59b', '#b347ff', '#ffb547', '#ff4d79', '#00b8d4'];

  return (
    <div className="page-container" style={{ maxWidth: '1600px' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '28px', flexWrap: 'wrap', gap: '16px' }}>
        <div>
          <div style={{ fontSize: '11px', color: '#6b7384', letterSpacing: '2px', textTransform: 'uppercase', fontWeight: 600, marginBottom: '6px' }}>
            Analytics e Performance
          </div>
          <h1 className="page-title" style={{ fontSize: '32px', fontWeight: 700, color: '#f4f6fb', margin: 0, letterSpacing: '-0.5px' }}>
            Relatórios
          </h1>
          <p style={{ color: '#9aa3b2', margin: '6px 0 0', fontSize: '14px' }}>
            Consolidado de tarefas da equipe e impacto da IA.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '10px' }}>
          <button onClick={exportCSV} className="ghost-btn">
            <Download size={14} /> Exportar CSV
          </button>
          <button onClick={exportPDF} className="neon-btn">
            <FileText size={14} /> Exportar PDF
          </button>
        </div>
      </header>

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '16px', marginBottom: '20px' }}>
        <Highlight
          Icon={Trophy}
          accent="#10f59b"
          label="Top Performer"
          value={topPerformer?.name ?? '—'}
          hint={topPerformer ? `${topPerformer.rate}% conclusão` : ''}
        />
        <Highlight
          Icon={Zap}
          accent="#b347ff"
          label="Mais Cobrado pela IA"
          value={mostNudged?.name ?? '—'}
          hint={mostNudged ? `${mostNudged.nudges}x cobrado` : ''}
        />
        <Highlight
          Icon={TrendingUp}
          accent="#00e5ff"
          label="Taxa Geral da Equipe"
          value={`${teamRate}%`}
          hint={`${tasks.length} tarefas totais`}
        />
        <Highlight
          Icon={Users2}
          accent="#ffb547"
          label="Responsáveis Ativos"
          value={String(rows.length)}
          hint="com tarefas em aberto"
        />
      </section>

      <section className="glass" style={{ padding: '24px', marginBottom: '20px' }}>
        <div style={{ marginBottom: '18px' }}>
          <div style={{ fontSize: '11px', color: '#6b7384', letterSpacing: '1.6px', textTransform: 'uppercase', fontWeight: 600, marginBottom: '4px' }}>
            Comparativo
          </div>
          <h2 style={{ fontSize: '17px', fontWeight: 600, color: '#f4f6fb', margin: 0 }}>
            Taxa de conclusão por responsável
          </h2>
        </div>
        <ResponsiveContainer width="100%" height={320}>
          <BarChart data={rows} margin={{ top: 5, right: 10, left: -15, bottom: 0 }}>
            <CartesianGrid stroke="rgba(255,255,255,0.06)" strokeDasharray="3 3" />
            <XAxis dataKey="name" stroke="#6b7384" fontSize={11} tickLine={false} axisLine={{ stroke: 'rgba(255,255,255,0.08)' }} />
            <YAxis stroke="#6b7384" fontSize={11} tickLine={false} axisLine={false} unit="%" />
            <Tooltip
              cursor={{ fill: 'rgba(255,255,255,0.04)' }}
              contentStyle={{
                background: 'rgba(14,16,22,0.95)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '10px',
                color: '#f4f6fb',
                fontSize: '12px',
              }}
            />
            <Bar dataKey="rate" radius={[8, 8, 0, 0]}>
              {rows.map((_, i) => (
                <Cell key={i} fill={barColors[i % barColors.length]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </section>

      <section className="glass" style={{ padding: '0', overflow: 'hidden' }}>
        <div style={{ padding: '20px 24px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <h2 style={{ fontSize: '17px', fontWeight: 600, color: '#f4f6fb', margin: 0 }}>
            Performance detalhada da equipe
          </h2>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: 'rgba(255,255,255,0.03)' }}>
              {['Responsável', 'Total', 'Concluídas', 'Atrasadas', 'Cobranças IA', 'Taxa de Conclusão'].map((h) => (
                <th key={h} style={{ padding: '12px 16px', textAlign: 'left', fontSize: '11px', color: '#6b7384', fontWeight: 600, letterSpacing: '0.6px', textTransform: 'uppercase' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                <td style={{ padding: '14px 16px', fontSize: '13px', color: '#f4f6fb', fontWeight: 600 }}>{r.name}</td>
                <td style={{ padding: '14px 16px', fontSize: '13px', color: '#c6cdda' }}>{r.total}</td>
                <td style={{ padding: '14px 16px', fontSize: '13px', color: '#10f59b', fontWeight: 600 }}>{r.completed}</td>
                <td style={{ padding: '14px 16px', fontSize: '13px', color: r.overdue > 0 ? '#ff4d79' : '#c6cdda', fontWeight: r.overdue > 0 ? 600 : 400 }}>{r.overdue}</td>
                <td style={{ padding: '14px 16px', fontSize: '13px', color: '#b347ff', fontWeight: 600 }}>{r.nudges}x</td>
                <td style={{ padding: '14px 16px', minWidth: '200px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <div style={{ flex: 1, height: '6px', borderRadius: '4px', background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                      <div
                        style={{
                          width: `${r.rate}%`, height: '100%',
                          background: r.rate >= 70
                            ? 'linear-gradient(90deg,#10f59b,#00e5ff)'
                            : r.rate >= 40
                              ? 'linear-gradient(90deg,#ffb547,#00e5ff)'
                              : 'linear-gradient(90deg,#ff4d79,#b347ff)',
                          transition: 'width 0.5s ease',
                        }}
                      />
                    </div>
                    <span style={{ fontSize: '12px', color: '#c6cdda', fontWeight: 600, minWidth: '38px' }}>{r.rate}%</span>
                  </div>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} style={{ padding: '32px', textAlign: 'center', color: '#6b7384' }}>Nenhum dado disponível</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function Highlight({
  Icon, accent, label, value, hint,
}: {
  Icon: typeof Trophy; accent: string; label: string; value: string; hint: string;
}) {
  return (
    <div className="glass" style={{ padding: '20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '14px' }}>
        <div style={{
          width: '38px', height: '38px', borderRadius: '10px',
          background: `${accent}18`, border: `1px solid ${accent}40`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Icon size={17} color={accent} strokeWidth={2} />
        </div>
        <div style={{ fontSize: '11px', color: '#6b7384', letterSpacing: '1.2px', textTransform: 'uppercase', fontWeight: 600 }}>
          {label}
        </div>
      </div>
      <div style={{ fontSize: '20px', fontWeight: 700, color: '#f4f6fb', letterSpacing: '-0.3px' }}>{value}</div>
      <div style={{ fontSize: '12px', color: '#9aa3b2', marginTop: '4px' }}>{hint}</div>
    </div>
  );
}
