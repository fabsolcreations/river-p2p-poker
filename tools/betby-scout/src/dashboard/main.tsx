import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './theme.css';
import { App } from './App.tsx';

const container = document.getElementById('root');
if (!container) {
  // A missing root means index.html and this bundle have diverged. Fail loudly:
  // a blank page with no console error is the worst possible symptom.
  throw new Error('Betby Scout: #root is missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
