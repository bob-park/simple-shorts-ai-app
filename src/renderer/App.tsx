import { useEffect, useState } from 'react';

import { RouterProvider } from 'react-router-dom';

import { router } from './router';

export function App() {
  const [bootChecked, setBootChecked] = useState(false);

  useEffect(() => {
    void window.api.setupStatus().then((status) => {
      if (status === 'pending') {
        // HashRouter — set the location hash before mounting RouterProvider
        window.location.hash = '#/setup';
      }
      setBootChecked(true);
    });
  }, []);

  if (!bootChecked) return null;
  return <RouterProvider router={router} />;
}
