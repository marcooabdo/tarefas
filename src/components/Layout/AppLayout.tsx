import { useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';

function useNudgePoller() {
  useEffect(() => {
    async function tick() {
      try {
        const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/nudge-overdue-tasks`;
        await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({}),
        });
      } catch { /* best effort */ }
    }
    tick();
    const id = setInterval(tick, 60000);
    return () => clearInterval(id);
  }, []);
}

export function AppLayout() {
  useNudgePoller();

  return (
    <div className="app-shell">
      <Sidebar />
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
