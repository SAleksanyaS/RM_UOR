import React from 'react';
import { createRoot } from 'react-dom/client';
import { LegacyOkoEntry } from './LegacyOkoEntry';
import '../../features/connectors/workbench/oko.css';
createRoot(document.getElementById('root')!).render(<React.StrictMode><LegacyOkoEntry/></React.StrictMode>);
