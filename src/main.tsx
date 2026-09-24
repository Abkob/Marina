import { MOBILE_LAYOUT_QUERY } from './hooks/useMediaQuery';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { AuthGate } from './components/AuthGate.tsx';
import './index.css';
import { useAppStore } from './store/useAppStore';
import { readAppLocation } from './utils/appNavigation';
import { migrateDeviceBranding } from './utils/brandMigration';

try { migrateDeviceBranding(window.localStorage); } catch { /* Storage-limited browsers keep working. */ }

// A Home Screen launch is a fresh visit: always land on the calendar.
const initialLocation = readAppLocation(new URL(window.location.href));
if (initialLocation) useAppStore.setState(initialLocation);
else if (window.matchMedia(MOBILE_LAYOUT_QUERY).matches) {
  useAppStore.getState().setCurrentTab('Schedule');
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </StrictMode>
);
