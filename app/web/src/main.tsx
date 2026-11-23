import '@fontsource/atkinson-hyperlegible-next/400.css';
import '@fontsource/atkinson-hyperlegible-next/600.css';
import '@fontsource/atkinson-hyperlegible-next/700.css';
import './styles/tokens.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import App from './App';
import { CartProvider } from './state/cart';
import { CropsProvider } from './state/crops';
import { ThemeProvider } from './state/theme';

const container = document.getElementById('root');
if (!container) throw new Error('Élément racine introuvable.');

createRoot(container).render(
  <StrictMode>
    <ThemeProvider>
      <BrowserRouter>
        <CartProvider>
          <CropsProvider>
            <App />
          </CropsProvider>
        </CartProvider>
      </BrowserRouter>
    </ThemeProvider>
  </StrictMode>,
);
