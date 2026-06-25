/**
 * POS P11 — Online/offline indicator + queued-sales badge.
 * Designed to live in the Topbar.
 */
import React from 'react';
import { Wifi, WifiOff, CloudUpload, AlertTriangle } from 'lucide-react';
import { useOfflineQueue } from '@/features/pos/offline-queue';
import { toast } from 'sonner';

export const OfflineIndicator: React.FC = () => {
  const { online, pending, replaying, replay } = useOfflineQueue();

  const onClick = () => {
    if (pending.length === 0) return;
    if (!online) {
      toast.warning(`Offline — ${pending.length} sale${pending.length === 1 ? '' : 's'} queued. They will sync when the network returns.`);
      return;
    }
    toast.info(`Syncing ${pending.length} pending sale${pending.length === 1 ? '' : 's'}…`);
    replay();
  };

  return (
    <button
      type="button"
      onClick={onClick}
      title={
        online
          ? pending.length > 0
            ? `Online — ${pending.length} sale${pending.length === 1 ? '' : 's'} queued. Click to sync.`
            : 'Online — all sales synced'
          : `Offline — ${pending.length} sale${pending.length === 1 ? '' : 's'} queued. Sales are stored locally and will sync when the network returns.`
      }
      className={
        'pos-tbl-pill ' +
        (online
          ? (pending.length > 0 ? '!bg-amber-500/20 !border-amber-400/50' : '!bg-emerald-500/20 !border-emerald-400/50')
          : '!bg-rose-500/20 !border-rose-400/50')
      }
    >
      {online ? (
        pending.length > 0 ? <AlertTriangle className="h-3.5 w-3.5 text-amber-200" /> : <Wifi className="h-3.5 w-3.5 text-emerald-200" />
      ) : (
        <WifiOff className="h-3.5 w-3.5 text-rose-200" />
      )}
      <span className={online ? (pending.length > 0 ? 'text-amber-100' : 'text-emerald-100') : 'text-rose-100'}>
        {online ? (pending.length > 0 ? `${pending.length} queued` : 'Online') : `Offline · ${pending.length} queued`}
      </span>
      {pending.length > 0 && online && !replaying ? (
        <CloudUpload className="h-3 w-3 text-amber-200 ml-0.5" />
      ) : null}
    </button>
  );
};