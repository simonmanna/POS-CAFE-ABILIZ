// Closing statement preview + on-demand print — same look as the receipt / bill
// preview. Nothing is printed until the cashier presses Print; the ticket then
// goes straight to the thermal printer (ESC/POS), not the browser print dialog.
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Printer, X } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { toast } from 'sonner';
import { buildClosingStatementHtml, buildClosingStatementText, type ClosingStatementInput } from './closing-statement';

/** Screen-only height bounds for the preview paper (px). Long statements scroll. */
const PAPER_MIN_H = 320;
const PAPER_MAX_H = 660;

interface Props {
  open: boolean;
  sessionId: string;
  statement: ClosingStatementInput;
  onClose: () => void;
}

export const ClosingStatementDialog: React.FC<Props> = ({ open, sessionId, statement, onClose }) => {
  const [busy, setBusy] = useState(false);
  const [paperH, setPaperH] = useState<number>(PAPER_MIN_H);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Build once per open so the "Printed" timestamp matches what gets printed.
  const { text, html } = useMemo(
    () => ({ text: buildClosingStatementText(statement), html: buildClosingStatementHtml(statement) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open, statement],
  );

  // Shrink the preview paper to the ticket's real height (receipt preview pattern).
  const fitPaper = useCallback(() => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc?.body) return;
    const h = Math.ceil(doc.body.scrollHeight) + 2;
    if (h > 0) setPaperH(Math.min(PAPER_MAX_H, Math.max(PAPER_MIN_H, h)));
  }, []);

  const onPrint = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ ok: boolean; backend: string; message?: string }>(
        '/pos/receipts/print-closing-statement',
        { sessionId, text },
      );
      if (r.data.ok) {
        toast.success(r.data.backend === 'console' ? r.data.message ?? 'Logged (no printer)' : 'Closing statement sent to printer');
      } else {
        toast.warning(r.data.message ?? 'Printer error');
      }
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Print failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[640px] p-0 overflow-hidden">
        <DialogHeader className="bg-gradient-to-r from-slate-700 to-slate-900 text-white p-4">
          <DialogTitle className="text-white text-base font-bold flex items-center gap-2">
            <Printer className="h-4 w-4" /> Closing statement
          </DialogTitle>
          <DialogDescription className="text-slate-300 text-xs">
            Cash register closing summary for this shift. Press Print to send it to the receipt printer.
          </DialogDescription>
        </DialogHeader>

        <div className="bg-slate-200 p-4 flex justify-center">
          <iframe
            ref={iframeRef}
            srcDoc={html}
            title="Closing statement preview"
            className="bg-white shadow-md"
            style={{ width: 340, height: paperH }}
            onLoad={fitPaper}
          />
        </div>

        <DialogFooter className="border-t border-slate-200 p-3 bg-slate-50 flex flex-wrap gap-2 sm:justify-between">
          <Button variant="ghost" onClick={onClose}>
            <X className="h-4 w-4 mr-1" /> Close
          </Button>
          <Button onClick={onPrint} disabled={busy} title="Send to thermal printer" style={{ background: '#16a34a' }}>
            <Printer className="h-4 w-4 mr-1" /> {busy ? 'Sending…' : 'Print'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
