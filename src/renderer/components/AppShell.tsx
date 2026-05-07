import { Outlet } from 'react-router-dom';

import { Sidebar } from './Sidebar';

export function AppShell() {
  return (
    <>
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </>
  );
}
