import { Outlet } from 'react-router-dom';

import { NewJobStateProvider } from './NewJobStateContext';
import { Sidebar } from './Sidebar';

export function AppShell() {
  return (
    <NewJobStateProvider>
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </NewJobStateProvider>
  );
}
