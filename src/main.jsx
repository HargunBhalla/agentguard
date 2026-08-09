import React from 'react';
import { createRoot } from 'react-dom/client';
import AgentGuard from './AgentGuard.jsx';
import './styles/design.css';
import './styles/global.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {/* strictMode escalates every policy to a hard block; simMs sets how long
        the shadow simulation takes to settle. Both came from the prototype's
        prop panel. */}
    <AgentGuard strictMode={false} simMs={1500} />
  </React.StrictMode>
);
