import React from 'react';
import { createRoot } from 'react-dom/client';
import { OkoApp } from './OkoApp';
import '../../features/connectors/workbench/oko.css';
createRoot(document.getElementById('root')!).render(<React.StrictMode><OkoApp/></React.StrictMode>);
