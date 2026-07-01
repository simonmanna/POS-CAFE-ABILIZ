// On-screen preview for the receipt and KOT, with a "Print" button.
import React, { useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Printer, Download, X } from 'lucide-react';
import { buildReceiptHtml, buildKOTHtml, ReceiptContext } from './receipt-kot';
import type { Order } from './types';

interface Props {
  open: boolean;
  kind: 'RECEIPT' | 'KOT' | null;
  order: Order | null;
  station?: 'BAR' | 'KITCHEN' | 'CAFE';
  context: ReceiptContext;
  onClose: () => void;
  onPrint: () => Promise<void> | void;
  onPrintAll?: () => Promise<void> | void; // multi-station KOT
}

export const PreviewDialog: React.FC<Props> = ({ open, kind, order, station, context, onClose, onPrint, onPrintAll }) => {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [printing, setPrinting] = useState(false);
  const [printingAll, setPrintingAll] = useState(false);

  useEffect(() => {
    if (!open || !order || !kind) return;
    const html = kind === 'RECEIPT' ? buildReceiptHtml(order, context) : buildKOTHtml(order, station);
    const f = iframeRef.current;
    if (f) {
      f.srcdoc = html;
    }
  }, [open, kind, order, station, context]);

  const doPrint = async () => {
    setPrinting(true);
    try { await onPrint(); } finally { setPrinting(false); }
  };

  const doPrintAll = async () => {
    setPrintingAll(true);
    try { if (onPrintAll) await onPrintAll(); } finally { setPrintingAll(false); }
  };

  return (
    <Dialog open={open && !!kind} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[420px] p-0 overflow-hidden">
        <DialogHeader className="bg-gradient-to-r from-purple-500 to-purple-700 text-white p-3">
          <DialogTitle className="text-white text-sm font-bold flex items-center gap-2">
            {kind === 'RECEIPT' ? <Printer className="h-4 w-4" /> : <Printer className="h-4 w-4" />}
            {kind === 'RECEIPT' ? `Receipt · ${order?.orderNumber}` : `KOT · ${order?.orderNumber}${station ? ` · ${station}` : ''}`}
          </DialogTitle>
          <DialogDescription className="text-purple-100 text-xs">Preview before sending to the printer.</DialogDescription>
        </DialogHeader>
        <div className="bg-slate-200 p-3 max-h-[60vh] overflow-y-auto">
          <iframe
            ref={iframeRef}
            title="Preview"
            className="bg-white w-full"
            style={{ height: '60vh', border: '1px solid #cbd5e1', borderRadius: 6 }}
          />
        </div>
        <DialogFooter className="border-t border-slate-200 p-3 bg-slate-50">
          {kind === 'KOT' && onPrintAll ? (
            <Button variant="outline" onClick={doPrintAll} disabled={printingAll}>
              <Printer className="h-4 w-4 mr-1" /> Print all stations
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button onClick={doPrint} disabled={printing} style={{ background: '#8b5cf6' }}>
            <Printer className="h-4 w-4 mr-1" /> {printing ? 'Sending…' : 'Print'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
