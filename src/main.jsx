import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import QuickCapture from './components/QuickCapture.jsx';
import './styles.css';

const isQuick = window.location.hash.startsWith('#/quick');

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {isQuick ? <QuickCapture /> : <App />}
  </React.StrictMode>
);
