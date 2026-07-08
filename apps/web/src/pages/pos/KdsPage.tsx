// P5 — KDS page. Full-screen grid of open tickets per station.
import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChefHat, Coffee, Sandwich, ArrowLeft, Volume2, VolumeX, Check, RotateCcw, Truck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useKdsTickets, useKdsTransition, type KdsTicketFE, type KdsTicketItemFE } from './pos-features-api';
import './pos-pro.css';

const STATIONS = [
  { key: 'bar' as const, label: 'Bar', icon: Coffee, color: 'bg-amber-500' },
  { key: 'kitchen' as const, label: 'Kitchen', icon: ChefHat, color: 'bg-rose-500' },
  { key: 'cafe' as const, label: 'Cafe', icon: Sandwich, color: 'bg-emerald-500' },
];

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const TicketCard: React.FC<{
  ticket: KdsTicketFE;
  onAction: (action: 'start' | 'ready' | 'serve' | 'cancel') => void;
  pending: boolean;
}> = ({ ticket, onAction, pending }) => {
  const status = ticket.status;
  const colors: Record<string, string> = {
    new: 'border-blue-400 bg-blue-50',
    preparing: 'border-amber-400 bg-amber-50',
    ready: 'border-emerald-400 bg-emerald-50',
    served: 'border-slate-300 bg-slate-50 opacity-60',
    cancelled: 'border-rose-300 bg-rose-50 opacity-60',
  };
  return (
    <div className={`rounded-2xl border-2 ${colors[status]} p-4 shadow-sm transition`}>
      <div className="flex items-center justify-between mb-2">
        <div className="font-extrabold text-lg">{ticket.label}</div>
        <div className="text-xs text-slate-500 font-mono">{timeAgo(ticket.createdAt)}</div>
      </div>
      <div className="space-y-2 mb-3">
        {ticket.items.map((it: KdsTicketItemFE, idx) => (
          <div key={idx} className="bg-white rounded-lg p-2 shadow-sm">
            <div className="flex items-center justify-between">
              <div className="font-bold text-sm">
                {it.quantity > 1 ? <span className="text-amber-700 mr-1.5">{it.quantity}×</span> : null}
                {it.productName}
              </div>
            </div>
            {it.variantName && (
              <div className="text-[11px] font-semibold text-slate-700 mt-0.5">{it.variantName}</div>
            )}
            {it.accompanimentNames && it.accompanimentNames.length > 0 && (
              <div className="text-[11px] text-slate-600 mt-0.5">+ {it.accompanimentNames.join(', ')}</div>
            )}
            {it.modifiers.length > 0 ? (
              <div className="text-[11px] text-slate-600 mt-0.5">
                {it.modifiers.map((m) => (m as any).kitchenPrintName ?? m.name).join(', ')}
              </div>
            ) : null}
            {it.notes ? (
              <div className="text-[11px] italic text-amber-700 mt-0.5">! {it.notes}</div>
            ) : null}
          </div>
        ))}
      </div>
      <div className="flex gap-1.5">
        {status === 'new' ? (
          <Button onClick={() => onAction('start')} disabled={pending} className="flex-1" style={{ background: '#f59e0b' }}>
            <ChefHat className="h-3.5 w-3.5 mr-1" /> Start
          </Button>
        ) : null}
        {status === 'preparing' ? (
          <Button onClick={() => onAction('ready')} disabled={pending} className="flex-1" style={{ background: '#16a34a' }}>
            <Check className="h-3.5 w-3.5 mr-1" /> Ready
          </Button>
        ) : null}
        {status === 'ready' ? (
          <Button onClick={() => onAction('serve')} disabled={pending} className="flex-1" style={{ background: '#0f172a' }}>
            <Truck className="h-3.5 w-3.5 mr-1" /> Served
          </Button>
        ) : null}
        {(status === 'new' || status === 'preparing') ? (
          <Button onClick={() => onAction('cancel')} disabled={pending} variant="outline" className="border-rose-300 text-rose-600 px-2">
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
        ) : null}
        {status === 'served' || status === 'cancelled' ? (
          <div className="flex-1 text-center text-xs text-slate-500 italic py-2">archived</div>
        ) : null}
      </div>
    </div>
  );
};

const KdsPage: React.FC = () => {
  const navigate = useNavigate();
  const [station, setStation] = useState<'bar' | 'kitchen' | 'cafe' | 'all'>('all');
  const [muted, setMuted] = useState(false);
  const lastCountRef = useRef<number>(0);
  const audioCtxRef = useRef<AudioContext | null>(null);

  const stationFilter = station === 'all' ? undefined : station;
  const { data: tickets = [] } = useKdsTickets(stationFilter, 2_000);
  const transition = useKdsTransition();

  // Audio chime when a new ticket arrives.
  useEffect(() => {
    const active = tickets.filter((t) => t.status === 'new' || t.status === 'ready').length;
    if (active > lastCountRef.current && !muted) {
      try {
        if (!audioCtxRef.current) {
          audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
        }
        const ctx = audioCtxRef.current!;
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.connect(g);
        g.connect(ctx.destination);
        o.frequency.value = 880;
        g.gain.setValueAtTime(0, ctx.currentTime);
        g.gain.linearRampToValueAtTime(0.2, ctx.currentTime + 0.05);
        g.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.4);
        o.start();
        o.stop(ctx.currentTime + 0.45);
      } catch { /* noop */ }
    }
    lastCountRef.current = active;
  }, [tickets, muted]);

  const onAction = (ticketId: string, action: 'start' | 'ready' | 'serve' | 'cancel') => {
    transition.mutate({ ticketId, action });
  };

  return (
    <div className="pos-reports-shell" style={{ minHeight: '100vh' }}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => navigate('/pos/terminal')}>
            <ArrowLeft className="h-4 w-4 mr-1" /> Back
          </Button>
          <h1 className="text-2xl font-extrabold flex items-center gap-2">
            <ChefHat className="h-6 w-6" /> KDS — Kitchen Display
          </h1>
          <span className="text-sm text-slate-500">
            {tickets.filter((t) => t.status === 'new' || t.status === 'preparing').length} active
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-1">
            <Button
              variant={station === 'all' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setStation('all')}
            >All</Button>
            {STATIONS.map((s) => (
              <Button
                key={s.key}
                variant={station === s.key ? 'default' : 'outline'}
                size="sm"
                onClick={() => setStation(s.key)}
                style={station === s.key ? { background: s.color, color: 'white' } : {}}
              >
                <s.icon className="h-3.5 w-3.5 mr-1" /> {s.label}
              </Button>
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={() => setMuted((m) => !m)}>
            {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      {tickets.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-slate-400">
          <div className="text-center">
            <ChefHat className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <p className="text-lg font-semibold">All caught up!</p>
            <p className="text-sm">No active tickets.</p>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {tickets
            .filter((t) => t.status !== 'cancelled')
            .map((t) => (
              <TicketCard
                key={t.id}
                ticket={t}
                onAction={(action) => onAction(t.id, action)}
                pending={transition.isPending}
              />
            ))}
        </div>
      )}
    </div>
  );
};

export default KdsPage;