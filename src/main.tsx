import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PorscheDesignSystemProvider } from '@porsche-design-system/components-react';
import App from './App';
import './index.css';

document.documentElement.classList.add('dark');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PorscheDesignSystemProvider theme="dark">
      <App />
    </PorscheDesignSystemProvider>
  </StrictMode>
);
