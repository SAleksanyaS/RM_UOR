import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import '@salutejs/sdds-themes/css/sdds_serv_malachite__light.css';
import './styles.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
