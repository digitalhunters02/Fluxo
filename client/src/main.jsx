import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import './planPreview'; // "ver como plano" do dono: manda X-Preview-Plan nos pedidos ao servidor (o servidor só obedece ao dono)
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode><BrowserRouter><App /></BrowserRouter></React.StrictMode>,
);
