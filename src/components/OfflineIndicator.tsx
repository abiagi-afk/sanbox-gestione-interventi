import React from 'react';
import { WifiOff } from 'lucide-react';
import { useOnlineStatus } from '../hooks/usePWAInstall';

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();

  if (isOnline) return null;

  return (
    <div
      role="status"
      className="fixed top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-lg bg-slate-900 border border-slate-800 px-4 py-2 text-xs font-semibold text-white"
    >
      <WifiOff className="w-4 h-4 shrink-0" />
      <span className="whitespace-nowrap">
        Connessione assente · Dati locali
      </span>
    </div>
  );
};
