import { Outlet, useLocation } from 'react-router-dom';

import { NewJobStateProvider } from './NewJobStateContext';
import { Sidebar } from './Sidebar';

export function AppShell() {
  const location = useLocation();
  const isSetup = location.pathname === '/setup';
  return (
    <NewJobStateProvider>
      {isSetup ? null : <Sidebar />}
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </NewJobStateProvider>
  );
}
