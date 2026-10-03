// src/index.js
import React from 'react';
import ReactDOM from 'react-dom/client';

// 1. Leaflet CSS (Map)
import 'leaflet/dist/leaflet.css';

//  2. Mantine UI Core & Date styles
import '@mantine/core/styles.css';
import '@mantine/dates/styles.css';

// 3. Mantine Provider + React Router
import { MantineProvider } from '@mantine/core';
import { BrowserRouter } from 'react-router-dom';

// 4. Routing logic from AppRoutes
import AppRoutes from './AppRoutes';
import reportWebVitals from './reportWebVitals';
import './index.css'; // optional

// 5. Load Inter Font (recommended)
const font = document.createElement("link");
font.href = "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700&display=swap";
font.rel = "stylesheet";
document.head.appendChild(font);

// 6. React 18+ Compatible Rendering
const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found. Make sure index.html has <div id="root"></div>');
}

const root = ReactDOM.createRoot(rootElement);

root.render(
  <React.StrictMode>
    <BrowserRouter>
      <MantineProvider
        withGlobalStyles
        withNormalizeCSS
        theme={{
          colorScheme: 'light',
          primaryColor: 'blue',
          fontFamily: 'Inter, sans-serif',
          headings: { fontFamily: 'Inter, sans-serif' },
        }}
      >
        <AppRoutes /> {/* Handles all routes & role-based redirects */}
      </MantineProvider>
    </BrowserRouter>
  </React.StrictMode>
);

// Optional: Log performance
reportWebVitals(console.log);