import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AppLayout } from './components/Layout/AppLayout';
import { Dashboard } from './pages/Dashboard';
import { Tasks } from './pages/Tasks';
import { Automation } from './pages/Automation';
import { Reports } from './pages/Reports';
import { Contacts } from './pages/Contacts';
import { Templates } from './pages/Templates';
import { Scheduling } from './pages/Scheduling';
import { Settings } from './pages/Settings';
import { Logs } from './pages/Logs';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/automation" element={<Automation />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/contacts" element={<Contacts />} />

          <Route path="/templates" element={<Templates />} />
          <Route path="/scheduling" element={<Scheduling />} />
          <Route path="/logs" element={<Logs />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
