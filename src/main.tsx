import React from 'react';
import ReactDOM from 'react-dom/client';

import App from './app/App';
import './core/ui/styles/global.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Missing #root container. Check index.html app shell mount point.');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
