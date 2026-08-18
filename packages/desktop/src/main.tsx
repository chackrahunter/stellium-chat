import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import './styles/app.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root fehlt im HTML');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
