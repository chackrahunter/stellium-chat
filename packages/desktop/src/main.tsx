import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import { updatesVerbinden } from './lib/updates.js';
import './styles/app.css';

/**
 * Plattform setzen, bevor React das erste Mal zeichnet. Auf macOS liegen die
 * Fensterknöpfe im Fensterinhalt; das Layout muss von Anfang an Platz lassen,
 * sonst blitzt das Logo unter den Knöpfen auf.
 */
document.documentElement.dataset.platform = window.stellium?.platform ?? 'browser';

const container = document.getElementById('root');
if (!container) throw new Error('#root fehlt im HTML');

updatesVerbinden();

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
