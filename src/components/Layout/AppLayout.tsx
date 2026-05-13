import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';

export function AppLayout() {
  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <Sidebar />
      <main
        style={{
          flex: 1,
          overflowX: 'hidden',
          overflowY: 'auto',
          minWidth: 0,
        }}
      >
        <Outlet />
      </main>
    </div>
  );
}
