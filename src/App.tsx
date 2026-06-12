import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AppLayout } from './components/Layout/AppLayout';

const Dashboard = lazy(() => import('./pages/Dashboard').then(m => ({ default: m.Dashboard })));
const Tasks = lazy(() => import('./pages/Tasks').then(m => ({ default: m.Tasks })));
const Automation = lazy(() => import('./pages/Automation').then(m => ({ default: m.Automation })));
const Reports = lazy(() => import('./pages/Reports').then(m => ({ default: m.Reports })));
const Contacts = lazy(() => import('./pages/Contacts').then(m => ({ default: m.Contacts })));
const Templates = lazy(() => import('./pages/Templates').then(m => ({ default: m.Templates })));
const Scheduling = lazy(() => import('./pages/Scheduling').then(m => ({ default: m.Scheduling })));
const Settings = lazy(() => import('./pages/Settings').then(m => ({ default: m.Settings })));
const Logs = lazy(() => import('./pages/Logs').then(m => ({ default: m.Logs })));

function PageLoader() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', padding: '2rem' }}>
      <p>Carregando...</p>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<PageLoader />}>
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
      </Suspense>
    </BrowserRouter>
  );
}
