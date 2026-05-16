import { NavLink } from 'react-router-dom';
import { LayoutDashboard, SquareKanban as KanbanSquare, Bot, ChartBar as BarChart3, Users, FileText, CalendarClock, ListChecks, Settings as SettingsIcon, Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

type NavItem = { to: string; label: string; Icon: LucideIcon; exact?: boolean };

const primary: NavItem[] = [
  { to: '/', label: 'Dashboard', Icon: LayoutDashboard, exact: true },
  { to: '/tasks', label: 'Gestor de Tarefas', Icon: KanbanSquare },
  { to: '/automation', label: 'Automação e IA', Icon: Bot },
  { to: '/reports', label: 'Relatórios', Icon: BarChart3 },
];

const secondary: NavItem[] = [
  { to: '/contacts', label: 'Contatos', Icon: Users },
  { to: '/templates', label: 'Templates', Icon: FileText },
  { to: '/scheduling', label: 'Agendamentos', Icon: CalendarClock },
  { to: '/logs', label: 'Logs de Envio', Icon: ListChecks },
  { to: '/settings', label: 'Configurações', Icon: SettingsIcon },
];

function SidebarLink({ item }: { item: NavItem }) {
  const { to, label, Icon, exact } = item;
  return (
    <NavLink
      to={to}
      end={exact}
      style={({ isActive }) => ({
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '10px 12px',
        borderRadius: '10px',
        textDecoration: 'none',
        fontSize: '13.5px',
        fontWeight: isActive ? 600 : 500,
        color: isActive ? '#07080c' : '#c6cdda',
        background: isActive
          ? 'linear-gradient(135deg, #00e5ff 0%, #b347ff 100%)'
          : 'transparent',
        marginBottom: '4px',
        transition: 'all 0.2s cubic-bezier(.25,.1,.25,1)',
        letterSpacing: '0.1px',
        boxShadow: isActive ? '0 6px 20px rgba(0,229,255,0.2)' : 'none',
      })}
    >
      {({ isActive }) => (
        <>
          <Icon size={18} strokeWidth={isActive ? 2.4 : 1.8} />
          <span>{label}</span>
        </>
      )}
    </NavLink>
  );
}

export function Sidebar() {
  return (
    <aside
      style={{
        width: '250px',
        minHeight: '100vh',
        background: 'linear-gradient(180deg, rgba(14,16,22,0.95) 0%, rgba(7,8,12,0.98) 100%)',
        borderRight: '1px solid rgba(255,255,255,0.06)',
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
        position: 'sticky',
        top: 0,
        height: '100vh',
      }}
    >
      <div
        style={{
          padding: '20px 18px 18px',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        <div
          style={{
            width: '40px',
            height: '40px',
            borderRadius: '10px',
            background: 'linear-gradient(135deg, #00e5ff 0%, #b347ff 100%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            boxShadow: '0 8px 24px rgba(0,229,255,0.35)',
          }}
        >
          <Sparkles size={20} color="#07080c" strokeWidth={2.4} />
        </div>
        <div>
          <div style={{ fontSize: '14px', fontWeight: 700, color: '#f4f6fb', lineHeight: 1.15, letterSpacing: '0.2px' }}>
            NEXUS AI - GIA - GROUP GLOBAL
          </div>
          <div style={{ fontSize: '11px', color: '#6b7384', letterSpacing: '0.4px', textTransform: 'uppercase' }}>
            Task Command Center
          </div>
        </div>
      </div>

      <nav style={{ padding: '16px 12px', flex: 1, overflowY: 'auto' }}>
        <div style={{ padding: '0 8px 8px', fontSize: '10px', color: '#6b7384', letterSpacing: '1.2px', textTransform: 'uppercase', fontWeight: 600 }}>
          Operações
        </div>
        {primary.map((item) => (
          <SidebarLink key={item.to} item={item} />
        ))}

        <div style={{ padding: '16px 8px 8px', fontSize: '10px', color: '#6b7384', letterSpacing: '1.2px', textTransform: 'uppercase', fontWeight: 600 }}>
          WhatsApp
        </div>
        {secondary.map((item) => (
          <SidebarLink key={item.to} item={item} />
        ))}
      </nav>

      <div
        style={{
          padding: '14px 16px',
          margin: '0 12px 12px',
          borderRadius: '12px',
          background: 'rgba(16, 245, 155, 0.06)',
          border: '1px solid rgba(16, 245, 155, 0.2)',
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
        }}
      >
        <span className="neon-dot" />
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <span style={{ fontSize: '12px', color: '#10f59b', fontWeight: 600 }}>Sistema Online</span>
          <span style={{ fontSize: '10px', color: '#6b7384' }}>IA monitorando</span>
        </div>
      </div>
    </aside>
  );
}
