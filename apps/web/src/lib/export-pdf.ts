import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

export interface ExportPdfOptions {
  /** Line under the title, e.g. the active filters. */
  subtitle?: string;
  orientation?: 'portrait' | 'landscape';
  /** Per-column alignment, by column index. */
  align?: Array<'left' | 'right' | 'center' | undefined>;
  /** Summary rows appended after the body in bold (e.g. totals). */
  foot?: string[][];
}

export function exportPDF(
  filename: string,
  title: string,
  headers: string[],
  rows: string[][],
  opts: ExportPdfOptions = {},
) {
  const orientation = opts.orientation ?? (headers.length > 6 ? 'landscape' : 'portrait');
  const doc = new jsPDF({ orientation });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  doc.setFontSize(14);
  doc.text(title, 14, 18);
  doc.setFontSize(8);
  doc.setTextColor(110);
  doc.text(`Generated ${new Date().toLocaleString()} · ${rows.length} row(s)`, 14, 24);
  let startY = 30;
  if (opts.subtitle) {
    const lines = doc.splitTextToSize(opts.subtitle, pageWidth - 28);
    doc.text(lines, 14, 29);
    startY = 29 + lines.length * 3.5 + 3;
  }
  doc.setTextColor(0);

  const columnStyles: Record<number, { halign: 'left' | 'right' | 'center' }> = {};
  opts.align?.forEach((a, i) => {
    if (a) columnStyles[i] = { halign: a };
  });

  autoTable(doc, {
    head: [headers],
    body: rows,
    foot: opts.foot,
    startY,
    styles: { fontSize: 8, cellPadding: 1.8 },
    headStyles: { fillColor: [60, 141, 188] },
    footStyles: { fillColor: [241, 245, 249], textColor: 20, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    showFoot: 'lastPage',
    columnStyles,
    didDrawPage: () => {
      doc.setFontSize(7);
      doc.setTextColor(130);
      doc.text(
        `Page ${doc.getCurrentPageInfo().pageNumber}`,
        pageWidth - 14,
        pageHeight - 8,
        { align: 'right' },
      );
      doc.setTextColor(0);
    },
  });
  doc.save(filename);
}
