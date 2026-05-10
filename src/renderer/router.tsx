import { createHashRouter } from 'react-router-dom';

import { AppShell } from './components/AppShell';
import { HistoryPage } from './pages/History';
import { NewJobPage } from './pages/NewJob';
import { SettingsPage } from './pages/Settings';
import { SetupPage } from './pages/Setup';

// Hash router avoids file:// path issues when running the packaged app.
export const router = createHashRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { path: 'setup', element: <SetupPage /> },
      { index: true, element: <NewJobPage /> },
      { path: 'history', element: <HistoryPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
]);
