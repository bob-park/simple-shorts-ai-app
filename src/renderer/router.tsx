import { createHashRouter } from 'react-router-dom';

import { AppShell } from './components/AppShell';
import { HistoryPage } from './pages/History';
import { NewJobPage } from './pages/NewJob';
import { SettingsPage } from './pages/Settings';

// Hash router avoids file:// path issues when running the packaged app.
export const router = createHashRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <NewJobPage /> },
      { path: 'history', element: <HistoryPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
]);
