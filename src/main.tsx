import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import StemSquash from './StemSquash';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StemSquash />
  </StrictMode>,
);
