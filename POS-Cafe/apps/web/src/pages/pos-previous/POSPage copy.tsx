// @ts-nocheck — pre-existing stale duplicate of POSPage.tsx; not used in App.tsx routing.
import React, { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import api from "../../services/api";
import { Category, Menu, Order, OrderItem, Customer, AddOn } from "../../types";
import { InputText } from "primereact/inputtext";
import { Button } from "primereact/button";
import { Dialog } from "primereact/dialog";
import { InputNumber } from "primereact/inputnumber";
import { RadioButton } from "primereact/radiobutton";
import { Checkbox } from "primereact/checkbox";
import { Toast } from "primereact/toast";
import { Divider } from "primereact/divider";
import { ConfirmDialog, confirmDialog } from "primereact/confirmdialog";
import { Avatar } from "primereact/avatar";

// ─── Inject global stylesheet once ───────────────────────────────────────────
const GLOBAL_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Nunito:wght@400;500;600;700;800;900&display=swap');

  :root {
    --pos-primary:    #1a7fcf;
    --pos-primary-d:  #1565a8;
    --pos-primary-l:  #e8f3fb;
    --pos-primary-ll: #f0f7fd;
    --pos-accent:     #17a2b8;
    --pos-success:    #28a745;
    --pos-warning:    #ffc107;
    --pos-danger:     #dc3545;
    --pos-surface:    #ffffff;
    --pos-bg:         #eef3f8;
    --pos-border:     #d0e3f0;
    --pos-border-d:   #b3cfe8;
    --pos-text:       #2c3e50;
    --pos-text-sub:   #6c7a8d;
    --pos-text-muted: #9baab8;
    --pos-shadow:     0 2px 12px rgba(26,127,207,.12);
    --pos-shadow-lg:  0 8px 32px rgba(26,127,207,.18);
    --pos-radius:     10px;
    --pos-radius-lg:  16px;
    --pos-font:       'Nunito', 'Segoe UI', sans-serif;
  }

  .pos-wrap * { box-sizing: border-box; font-family: var(--pos-font); }

  /* ── Scrollbars ── */
  .pos-scroll::-webkit-scrollbar { width: 5px; height: 5px; }
  .pos-scroll::-webkit-scrollbar-track { background: #f0f4f8; border-radius: 4px; }
  .pos-scroll::-webkit-scrollbar-thumb { background: var(--pos-border-d); border-radius: 4px; }

  /* ── AdminLTE-style dialog card ── */
  .pos-dlg .p-dialog {
    border-radius: var(--pos-radius-lg) !important;
    box-shadow: var(--pos-shadow-lg) !important;
    border: 1px solid var(--pos-border) !important;
    overflow: hidden !important;
  }
  .pos-dlg .p-dialog-header {
    background: var(--pos-primary) !important;
    color: #fff !important;
    padding: 14px 20px !important;
    font-size: 15px !important;
    font-weight: 700 !important;
    font-family: var(--pos-font) !important;
    border-bottom: none !important;
  }
  .pos-dlg .p-dialog-header .p-dialog-title { color: #fff !important; font-weight: 700 !important; }
  .pos-dlg .p-dialog-header-icons .p-dialog-header-icon { color: rgba(255,255,255,.8) !important; }
  .pos-dlg .p-dialog-header-icons .p-dialog-header-icon:hover { color: #fff !important; background: rgba(255,255,255,.15) !important; border-radius: 6px !important; }
  .pos-dlg .p-dialog-content { padding: 0 !important; background: #fff !important; }
  .pos-dlg .p-dialog-footer { background: #f6fafd !important; border-top: 1px solid var(--pos-border) !important; padding: 12px 20px !important; }

  /* ── AdminLTE card-style inner sections ── */
  .pos-card {
    background: #fff;
    border: 1px solid var(--pos-border);
    border-radius: var(--pos-radius);
    box-shadow: 0 1px 4px rgba(26,127,207,.07);
  }
  .pos-card-header {
    background: var(--pos-primary-l);
    border-bottom: 1px solid var(--pos-border);
    padding: 10px 16px;
    font-size: 13px;
    font-weight: 700;
    color: var(--pos-primary-d);
    text-transform: uppercase;
    letter-spacing: .5px;
    border-radius: var(--pos-radius) var(--pos-radius) 0 0;
  }

  /* ── Inputs ── */
  .pos-input {
    width: 100%;
    height: 42px;
    padding: 0 14px;
    border: 1.5px solid var(--pos-border-d);
    border-radius: var(--pos-radius);
    font-size: 14px;
    color: var(--pos-text);
    background: #fff;
    font-family: var(--pos-font);
    transition: border-color .18s, box-shadow .18s;
    outline: none;
  }
  .pos-input:focus {
    border-color: var(--pos-primary);
    box-shadow: 0 0 0 3px rgba(26,127,207,.13);
  }
  .pos-input::placeholder { color: var(--pos-text-muted); }
  .pos-input-icon { position: relative; }
  .pos-input-icon i { position: absolute; left: 13px; top: 50%; transform: translateY(-50%); color: var(--pos-text-muted); font-size: 14px; }
  .pos-input-icon input { padding-left: 38px; }

  /* ── Buttons ── */
  .pos-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    padding: 9px 20px;
    border-radius: var(--pos-radius);
    border: none;
    font-size: 14px;
    font-weight: 700;
    font-family: var(--pos-font);
    cursor: pointer;
    transition: all .18s;
  }
  .pos-btn-primary   { background: var(--pos-primary); color: #fff; box-shadow: 0 3px 10px rgba(26,127,207,.3); }
  .pos-btn-primary:hover { background: var(--pos-primary-d); box-shadow: 0 5px 16px rgba(26,127,207,.4); }
  .pos-btn-success   { background: var(--pos-success); color: #fff; box-shadow: 0 3px 10px rgba(40,167,69,.25); }
  .pos-btn-success:hover { background: #218838; }
  .pos-btn-danger    { background: var(--pos-danger); color: #fff; }
  .pos-btn-danger:hover  { background: #c82333; }
  .pos-btn-outline   { background: transparent; color: var(--pos-primary); border: 1.5px solid var(--pos-primary); }
  .pos-btn-outline:hover { background: var(--pos-primary-l); }
  .pos-btn-ghost     { background: #f0f4f8; color: var(--pos-text-sub); border: 1px solid var(--pos-border); }
  .pos-btn-ghost:hover   { background: var(--pos-border); }
  .pos-btn:disabled  { opacity: .5; cursor: not-allowed !important; }

  /* ── Type toggle tabs ── */
  .pos-type-tab {
    display: flex; align-items: center; gap: 6px;
    padding: 6px 14px;
    border-radius: 8px; border: none;
    font-size: 13px; font-weight: 600; cursor: pointer;
    font-family: var(--pos-font);
    transition: all .15s;
  }

  /* ── Category pills ── */
  .pos-cat-pill {
    display: flex; align-items: center; gap: 6px;
    padding: 7px 18px; border-radius: 50px; cursor: pointer;
    font-size: 13px; font-weight: 700; white-space: nowrap;
    transition: all .18s; border: none;
    font-family: var(--pos-font);
  }

  /* ── Menu cards ── */
  .pos-menu-card {
    background: #fff;
    border: 1px solid var(--pos-border);
    border-radius: var(--pos-radius-lg);
    overflow: hidden; cursor: pointer;
    transition: transform .18s, box-shadow .18s, border-color .18s;
    display: flex; flex-direction: column;
    box-shadow: 0 1px 4px rgba(26,127,207,.06);
  }
  .pos-menu-card:hover {
    transform: translateY(-3px);
    box-shadow: 0 8px 24px rgba(26,127,207,.16);
    border-color: var(--pos-primary);
  }
  .pos-menu-card.locked {
    opacity: .55; cursor: not-allowed; filter: grayscale(.3);
  }
  .pos-menu-card.locked:hover { transform: none; box-shadow: none; border-color: var(--pos-border); }

  /* ── Order item rows ── */
  .pos-order-item {
    display: flex; gap: 8px; align-items: flex-start;
    padding: 9px 10px; border-radius: 10px; margin-bottom: 4px;
    border: 1px solid transparent;
    background: #f8fbff;
    transition: background .15s;
  }
  .pos-order-item.kot { background: #f0fdf4; border-color: #bbf7d0; }
  .pos-order-item.voided { background: #fff1f0; border-color: #fecaca; opacity: .7; }

  /* ── Action buttons grid ── */
  .pos-action-btn {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 3px; padding: 8px 4px; border-radius: 10px; border: none;
    font-size: 11px; font-weight: 700; letter-spacing: .3px;
    text-transform: uppercase; cursor: pointer; min-height: 52px; width: 100%;
    font-family: var(--pos-font); transition: all .18s;
  }
  .pos-action-btn:hover:not(:disabled) { transform: translateY(-2px); filter: brightness(1.07); }
  .pos-action-btn:disabled { opacity: .45; cursor: not-allowed; }

  /* ── Addon checkbox item ── */
  .pos-addon-row {
    display: flex; align-items: center; gap: 12px;
    padding: 13px 16px; border-radius: 10px; cursor: pointer;
    border: 1.5px solid var(--pos-border);
    background: var(--pos-primary-ll);
    transition: all .18s; margin-bottom: 8px;
  }
  .pos-addon-row:hover { border-color: var(--pos-primary); background: var(--pos-primary-l); }
  .pos-addon-row.selected { border-color: var(--pos-primary); background: #daedf9; }

  /* ── Table card ── */
  .pos-table-card {
    position: relative; padding: 10px 6px 4px; border-radius: 14px;
    cursor: pointer; text-align: center;
    transition: all .22s cubic-bezier(.34,1.56,.64,1);
    border: 2px solid transparent;
  }
  .pos-table-card:hover { transform: translateY(-3px); box-shadow: 0 8px 24px rgba(26,127,207,.18) !important; }
  .pos-table-card.selected { transform: translateY(-2px); }

  /* ── Customer row ── */
  .pos-cust-row {
    display: flex; align-items: center; gap: 14px;
    padding: 13px 16px; border-radius: 10px; cursor: pointer;
    border: 1.5px solid var(--pos-border); background: var(--pos-primary-ll);
    transition: all .18s; margin-bottom: 8px;
  }
  .pos-cust-row:hover { border-color: var(--pos-primary); background: var(--pos-primary-l); transform: translateX(3px); }

  /* ── Discount type toggle ── */
  .pos-disc-tab {
    flex: 1; padding: 10px 12px; border: none; border-radius: 8px;
    font-size: 14px; font-weight: 700; cursor: pointer;
    display: flex; align-items: center; justify-content: center; gap: 7px;
    font-family: var(--pos-font); transition: all .18s;
  }

  /* ── table-lock overlay ── */
  @keyframes lock-pulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.06); } }
  .lock-pulse { animation: lock-pulse 2s ease-in-out infinite; }

  /* ── Badge ── */
  .pos-badge {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 20px; height: 20px; border-radius: 10px;
    font-size: 11px; font-weight: 800; padding: 0 6px;
  }

  /* ── Divider label ── */
  .pos-divider-label {
    display: flex; align-items: center; gap: 12px; margin: 16px 0;
  }
  .pos-divider-label::before,.pos-divider-label::after {
    content:''; flex:1; height:1px; background: var(--pos-border-d);
  }
  .pos-divider-label span { font-size: 12px; font-weight: 700; color: var(--pos-text-muted); text-transform: uppercase; letter-spacing: .6px; }

  @keyframes fadeInUp { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }
  .fade-in-up { animation: fadeInUp .3s ease both; }
`;

if (!document.getElementById("pos-adminlte-style")) {
  const s = document.createElement("style");
  s.id = "pos-adminlte-style";
  s.textContent = GLOBAL_CSS;
  document.head.appendChild(s);
}

function openPrintWindow(html: string) {
  const win = window.open("", "_blank", "width=420,height=650");
  if (!win) {
    alert("Please allow popups to print.");
    return;
  }
  win.document.write(html);
  win.document.close();
  win.focus();
  setTimeout(() => {
    win.print();
    win.close();
  }, 500);
}

function buildKOTHtml(
  order: Order,
  items: OrderItem[],
  tableName: string,
): string {
  const rows = items
    .map(
      (i) => `
        <tr>
          <td style="padding:5px 0;font-size:16px;font-weight:700;border-bottom:1px dashed #ddd;">
            ${i.quantity} × ${i.menu?.name || ""}
          </td>
        </tr>
        ${
          i.addOns
            ? `<tr><td style="padding:0 0 5px 16px;font-size:12px;color:#555;border-bottom:1px dashed #ddd;">
            ${JSON.parse(i.addOns)
              .map((a: any) => `+ ${a.name}`)
              .join(", ")}
          </td></tr>`
            : ""
        }
    `,
    )
    .join("");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>KOT</title>
    <style>
      @media print { body{margin:0} }
      body{font-family:'Courier New',monospace;width:78mm;margin:0 auto;padding:8px 10px}
      h2{text-align:center;margin:0 0 2px;font-size:20px;letter-spacing:3px}
      .sub{text-align:center;font-size:11px;color:#777;margin-bottom:6px}
      .hr{border:none;border-top:1px dashed #000;margin:6px 0}
      table{width:100%;border-collapse:collapse}
      .meta{font-size:12px;line-height:1.8;margin-bottom:4px}
      .footer{text-align:center;font-size:11px;margin-top:10px;color:#555}
    </style></head><body>
    <h2>** KOT **</h2>
    <div class="sub">Ruta Pub — Kitchen Order Ticket</div>
    <hr class="hr"/>
    <div class="meta">
      <b>Order #:</b> ${order.orderNumber}<br/>
      <b>Table:</b> ${tableName}<br/>
      <b>Type:</b> ${order.type}<br/>
      <b>Time:</b> ${new Date().toLocaleTimeString("en-UG", { hour: "2-digit", minute: "2-digit" })}
    </div>
    <hr class="hr"/>
    <table>${rows}</table>
    <hr class="hr"/>
    <div class="footer">— Kitchen Copy · Do Not Discard —</div>
    </body></html>`;
}

function buildBillHtml(
  order: Order,
  items: OrderItem[],
  tableName: string,
  discountLabel: string,
): string {
  const rows = items
    .map(
      (i) => `
        <tr>
          <td style="padding:5px 0;font-size:13px;">${i.menu?.name || ""}
            ${
              i.addOns
                ? `<br/><small style="color:#999;">${JSON.parse(i.addOns)
                    .map((a: any) => `+${a.name}`)
                    .join(", ")}</small>`
                : ""
            }
          </td>
          <td style="text-align:center;padding:5px 0;">${i.quantity}</td>
          <td style="text-align:right;padding:5px 0;white-space:nowrap;">ugx${i.totalPrice + i.addOnsTotal}</td>
        </tr>`,
    )
    .join("");
  const discLine =
    (order.discountAmount ?? 0) > 0
      ? `<tr><td colspan="2" style="color:#16A34A;font-size:13px;">${discountLabel}</td><td style="text-align:right;color:#16A34A;white-space:nowrap;">-ugx${order.discountAmount}</td></tr>`
      : "";
  const taxLine =
    order.tax > 0
      ? `<tr><td colspan="2" style="font-size:13px;">Tax</td><td style="text-align:right;white-space:nowrap;">ugx${order.tax}</td></tr>`
      : "";
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Bill</title>
    <style>
      @media print { body{margin:0} }
      body{font-family:'Courier New',monospace;width:78mm;margin:0 auto;padding:8px 10px}
      h2{text-align:center;margin:0;font-size:22px;letter-spacing:2px}
      .sub{text-align:center;font-size:11px;color:#777;margin:2px 0 6px}
      .hr{border:none;border-top:1px dashed #000;margin:7px 0}
      table{width:100%;border-collapse:collapse}
      th{font-size:11px;text-transform:uppercase;color:#888;border-bottom:1px solid #000;padding-bottom:4px}
      .total-row td{font-weight:900;font-size:17px;border-top:1px solid #000;padding-top:6px}
      .footer{text-align:center;font-size:11px;margin-top:10px;color:#555}
      .meta{font-size:11px;line-height:1.8;margin-bottom:4px}
    </style></head><body>
    <h2>🍺 RUTA PUB</h2>
    <div class="sub">Good Vibes, Great Drinks</div>
    <hr class="hr"/>
    <div class="meta">
      <b>Receipt:</b> #${order.orderNumber}<br/>
      <b>Table:</b> ${tableName} &nbsp;|&nbsp; <b>Type:</b> ${order.type}<br/>
      ${order.customer ? `<b>Guest:</b> ${order.customer.name}<br/>` : ""}
      <b>Date:</b> ${new Date().toLocaleString("en-UG")}
    </div>
    <hr class="hr"/>
    <table>
      <thead><tr>
        <th style="text-align:left;">Item</th>
        <th style="text-align:center;">Qty</th>
        <th style="text-align:right;">Amount</th>
      </tr></thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr><td colspan="2" style="font-size:13px;">Subtotal</td><td style="text-align:right;white-space:nowrap;">ugx${order.subtotal}</td></tr>
        ${discLine}${taxLine}
        <tr class="total-row">
          <td colspan="2">TOTAL</td>
          <td style="text-align:right;white-space:nowrap;">ugx${order.total}</td>
        </tr>
      </tfoot>
    </table>
    <hr class="hr"/>
    <div class="footer">
      Thank you for visiting Ruta Pub! 🍺<br/>Please come again soon.
    </div>
    </body></html>`;
}

// ─── Utilities ────────────────────────────────────────────────────────────────
const FOOD_IMAGE_MAP: Record<string, string> = {
  burger:
    "https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=400&h=300&fit=crop",
  chicken:
    "https://images.unsplash.com/photo-1598514982901-e4e3b287bc91?w=400&h=300&fit=crop",
  pizza:
    "https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=400&h=300&fit=crop",
  pasta:
    "https://images.unsplash.com/photo-1621996346565-e3dbc646d9a9?w=400&h=300&fit=crop",
  salad:
    "https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=400&h=300&fit=crop",
  steak:
    "https://images.unsplash.com/photo-1558030137-a56c1b4cf6f4?w=400&h=300&fit=crop",
  sandwich:
    "https://images.unsplash.com/photo-1539252554453-80ab65ce3586?w=400&h=300&fit=crop",
  soup: "https://images.unsplash.com/photo-1547592166-23ac45744acd?w=400&h=300&fit=crop",
  coffee:
    "https://images.unsplash.com/photo-1509042239860-f550ce710b93?w=400&h=300&fit=crop",
  juice:
    "https://images.unsplash.com/photo-1621506289937-a8e4df240d0b?w=400&h=300&fit=crop",
  cake: "https://images.unsplash.com/photo-1578985545062-69928b1d9587?w=400&h=300&fit=crop",
  rice: "https://images.unsplash.com/photo-1536304929831-ee1ca9d44906?w=400&h=300&fit=crop",
  fish: "https://images.unsplash.com/photo-1519708227418-c8fd9a32b7a2?w=400&h=300&fit=crop",
  egg: "https://images.unsplash.com/photo-1482049016688-2d3e1b311543?w=400&h=300&fit=crop",
  curry:
    "https://images.unsplash.com/photo-1631452180519-c014fe946bc7?w=400&h=300&fit=crop",
};

const CATEGORY_EMOJI: Record<string, string> = {
  burger: "🍔",
  pizza: "🍕",
  sandwich: "🥪",
  snack: "🍟",
  vegetarian: "🥗",
  drink: "🥤",
  dessert: "🍰",
  chicken: "🍗",
  fish: "🐟",
  sushi: "🍣",
  pasta: "🍝",
  soup: "🍜",
  rice: "🍚",
  meat: "🥩",
  breakfast: "🍳",
  fruit: "🍎",
  salad: "🥙",
  coffee: "☕",
  all: "🍽️",
};

function getFoodImage(name: string, cat?: string): string | null {
  const t = (name + " " + (cat || "")).toLowerCase();
  for (const [k, v] of Object.entries(FOOD_IMAGE_MAP))
    if (t.includes(k)) return v;
  return null;
}
function getCategoryEmoji(name: string): string {
  const l = name.toLowerCase();
  for (const [k, v] of Object.entries(CATEGORY_EMOJI))
    if (l.includes(k)) return v;
  return "🍽️";
}

// ─── Table status config ──────────────────────────────────────────────────────
const TBL: Record<
  string,
  { bg: string; border: string; dot: string; label: string; textColor: string }
> = {
  available: {
    bg: "#f0fdf4",
    border: "#86efac",
    dot: "#16a34a",
    label: "Available",
    textColor: "#15803d",
  },
  occupied: {
    bg: "#fff7ed",
    border: "#fdba74",
    dot: "#ea580c",
    label: "Occupied",
    textColor: "#c2410c",
  },
  reserved: {
    bg: "#eff6ff",
    border: "#93c5fd",
    dot: "#2563eb",
    label: "Reserved",
    textColor: "#1d4ed8",
  },
};

// ─── Action buttons config ────────────────────────────────────────────────────
const ACTION_BTNS = [
  {
    key: "customer",
    icon: "pi-user-plus",
    label: "Customer",
    bg: "#1a7fcf",
    shadow: "rgba(26,127,207,.35)",
  },
  {
    key: "discount",
    icon: "pi-percentage",
    label: "Discount",
    bg: "#f59e0b",
    shadow: "rgba(245,158,11,.35)",
  },
  {
    key: "split",
    icon: "pi-arrows-h",
    label: "Split Bill",
    bg: "#ec4899",
    shadow: "rgba(236,72,153,.35)",
  },
  {
    key: "kot",
    icon: "pi-print",
    label: "Print KOT",
    bg: "#0ea5e9",
    shadow: "rgba(14,165,233,.35)",
  },
  {
    key: "bill",
    icon: "pi-file-pdf",
    label: "Print Bill",
    bg: "#8b5cf6",
    shadow: "rgba(139,92,246,.35)",
  },
  {
    key: "checkout",
    icon: "pi-wallet",
    label: "Checkout",
    bg: "#28a745",
    shadow: "rgba(40,167,69,.35)",
  },
];

// ─── Component ────────────────────────────────────────────────────────────────
const POSPage: React.FC = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const toast = useRef<Toast>(null);

  useEffect(() => {
    if (!user) navigate("/login", { replace: true });
  }, [user, navigate]);

  // Core state
  const [categories, setCategories] = useState<Category[]>([]);
  const [menus, setMenus] = useState<Menu[]>([]);
  const [filteredMenus, setFilteredMenus] = useState<Menu[]>([]);
  const [activeCategory, setActiveCategory] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [currentOrder, setCurrentOrder] = useState<Order | null>(null);
  const [selectedTable, setSelectedTable] = useState<any>(null); // full table obj
  const [orderType, setOrderType] = useState<
    "DINE_IN" | "TAKEAWAY" | "DELIVERY"
  >("DINE_IN");

  // Dialogs
  const [showAddOnDialog, setShowAddOnDialog] = useState(false);
  const [selectedMenu, setSelectedMenu] = useState<Menu | null>(null);
  const [selectedAddOns, setSelectedAddOns] = useState<number[]>([]);
  const [showPaymentDialog, setShowPaymentDialog] = useState(false);
  const [showDiscountDialog, setShowDiscountDialog] = useState(false);
  const [showCustomerDialog, setShowCustomerDialog] = useState(false);
  const [showOpenCashDialog, setShowOpenCashDialog] = useState(false);
  const [showTableDialog, setShowTableDialog] = useState(true); // open on mount
  const [showBillDialog, setShowBillDialog] = useState(false);

  // Payment
  const [paymentMethod, setPaymentMethod] = useState<"CASH" | "MOBILE_MONEY">(
    "CASH",
  );
  const [cashTendered, setCashTendered] = useState(0);
  const [mobileRef, setMobileRef] = useState("");
  const [splitPayments, setSplitPayments] = useState<
    Array<{ method: string; amount: number; reference?: string }>
  >([]);
  const [splitMode, setSplitMode] = useState(false);
  const [splitAmount, setSplitAmount] = useState(0);

  // Discount
  const [discountType, setDiscountType] = useState<"percentage" | "fixed">(
    "percentage",
  );
  const [discountValue, setDiscountValue] = useState(0);

  // Customer
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerSearch, setCustomerSearch] = useState("");
  const [newCustomerName, setNewCustomerName] = useState("");
  const [newCustomerPhone, setNewCustomerPhone] = useState("");

  // Cash register
  const [openingAmount, setOpeningAmount] = useState(0);
  const [hasOpenShift, setHasOpenShift] = useState(false);

  // Tables
  const [tables, setTables] = useState<any[]>([]);
  const [tableFilter, setTableFilter] = useState("all");
  const [hoveredTable, setHoveredTable] = useState<number | null>(null);

  useEffect(() => {
    loadCategories();
    loadMenus();
    loadTables();
  }, []);
  useEffect(() => {
    filterMenus();
  }, [activeCategory, searchQuery, menus]);

  const loadCategories = async () => {
    try {
      const r = await api.get("/categories");
      setCategories(r.data);
    } catch {}
  };
  const loadMenus = async () => {
    try {
      const r = await api.get("/menus");
      setMenus(r.data);
    } catch {}
  };
  const loadTables = async () => {
    try {
      const r = await api.get("/tables");
      setTables(r.data);
    } catch {}
  };
  const filterMenus = () => {
    let f = [...menus];
    if (activeCategory) f = f.filter((p) => p.categoryId === activeCategory);
    if (searchQuery)
      f = f.filter((p) =>
        p.name.toLowerCase().includes(searchQuery.toLowerCase()),
      );
    setFilteredMenus(f);
  };

  // ── Order Management ────────────────────────────────────────────────────────
  const createOrder = async (tableId?: number) => {
    try {
      const r = await api.post("/orders", {
        tableId,
        userId: user?.id,
        type: orderType,
      });
      setCurrentOrder(r.data);
      return r.data;
    } catch {
      toast.current?.show({
        severity: "error",
        summary: "Error",
        detail: "Failed to create order",
      });
    }
  };
  const addToOrder = async (menu: Menu) => {
    if (!selectedTable) return; // guarded by UI
    if (menu.addOns?.length) {
      setSelectedMenu(menu);
      setSelectedAddOns([]);
      setShowAddOnDialog(true);
      return;
    }
    await addItemToOrder(menu.id);
  };

  //   const addItemToOrder = async (menuId: number, addOns?: AddOn[]) => {
  //     try {
  //       let order = currentOrder;
  //       if (!order) { order = await createOrder(selectedTable?.id); if (!order) return; }
  //       const addOnsTotal = addOns ? addOns.reduce((s,a) => s + a.price, 0) : 0;
  //       const addOnsJson  = addOns ? JSON.stringify(addOns.map(a=>({id:a.id,name:a.name,price:a.price}))) : undefined;
  //       await api.post(`/orders/${order.id}/items`, { menuId, quantity:1, addOns:addOnsJson, addOnsTotal });
  //       await refreshOrder(order.id);
  //       toast.current?.show({ severity:"success", summary:"Added", detail:"Item added", life:1200 });
  //     } catch {
  //       toast.current?.show({ severity:"error", summary:"Error", detail:"Failed to add item" });
  //     }
  //   };

  const addItemToOrder = async (menuId: number, addOns?: AddOn[]) => {
    try {
      let order = currentOrder;
      // Create order only when first item is added (not when table is selected)
      if (!order) {
        order = await createOrder(selectedTable?.id);
        if (!order) return;
      }

      // Mark table as occupied when first item is added
      if (currentOrder === null && selectedTable) {
        try {
          await api.put(`/tables/${selectedTable.id}/status`, {
            status: "occupied",
          });
        } catch (e) {
          // Silently fail - table status update is not critical
        }
      }

      const addOnsTotal = addOns ? addOns.reduce((s, a) => s + a.price, 0) : 0;
      const addOnsJson = addOns
        ? JSON.stringify(
            addOns.map((a) => ({ id: a.id, name: a.name, price: a.price })),
          )
        : undefined;
      await api.post(`/orders/${order.id}/items`, {
        menuId,
        quantity: 1,
        addOns: addOnsJson,
        addOnsTotal,
      });
      await refreshOrder(order.id);
      toast.current?.show({
        severity: "success",
        summary: "Added",
        detail: "Item added",
        life: 1200,
      });
    } catch {
      toast.current?.show({
        severity: "error",
        summary: "Error",
        detail: "Failed to add item",
      });
    }
  };

  const confirmAddOns = async () => {
    if (!selectedMenu) return;
    const sel =
      selectedMenu.addOns?.filter((a) => selectedAddOns.includes(a.id)) || [];
    await addItemToOrder(selectedMenu.id, sel);
    setShowAddOnDialog(false);
  };
  const updateQuantity = async (itemId: number, quantity: number) => {
    if (!currentOrder || quantity < 1) return;
    try {
      await api.put(`/orders/${currentOrder.id}/items/${itemId}/quantity`, {
        quantity,
      });
      await refreshOrder(currentOrder.id);
    } catch {}
  };
  const removeItem = async (itemId: number) => {
    if (!currentOrder) return;
    confirmDialog({
      message: "Remove this item?",
      header: "Confirm",
      icon: "pi pi-trash",
      acceptClassName: "p-button-danger",
      accept: async () => {
        await api.delete(`/orders/${currentOrder.id}/items/${itemId}`);
        await refreshOrder(currentOrder.id);
      },
    });
  };
  const voidItem = async (itemId: number) => {
    if (!currentOrder) return;
    confirmDialog({
      message: "Void this item?",
      header: "Void Item",
      icon: "pi pi-exclamation-triangle",
      acceptClassName: "p-button-danger",
      accept: async () => {
        await api.put(`/orders/${currentOrder.id}/items/${itemId}/void`, {
          reason: "Voided by staff",
        });
        await refreshOrder(currentOrder.id);
      },
    });
  };
  const refreshOrder = async (orderId: number) => {
    try {
      const r = await api.get(`/orders/${orderId}`);
      setCurrentOrder(r.data);
    } catch {}
  };
  const applyDiscount = async () => {
    if (!currentOrder) return;
    try {
      const r = await api.put(`/orders/${currentOrder.id}/discount`, {
        discountType,
        discountValue,
      });
      setCurrentOrder(r.data);
      setShowDiscountDialog(false);
    } catch {}
  };
  const printKOT = async () => {
    if (!currentOrder) return;
    const newItems = activeItems.filter((i) => !i.kotPrinted);

    try {
      await api.post(`/orders/${currentOrder.id}/kot`);
      await refreshOrder(currentOrder.id);
      toast.current?.show({
        severity: "success",
        summary: "KOT Sent",
        detail: "Sent to kitchen printer",
        life: 2000,
      });
      await api.post(`/orders/${currentOrder.id}/kot`);
      await refreshOrder(currentOrder.id);
      openPrintWindow(
        buildKOTHtml(
          currentOrder,
          newItems,
          selectedTable ? `T${selectedTable.number}` : "Takeaway",
        ),
      );
      toast.current?.show({
        severity: "success",
        summary: "KOT Sent",
        detail: `${newItems.length} item(s) sent to kitchen`,
        life: 2000,
      });
    } catch {
      toast.current?.show({
        severity: "error",
        summary: "Error",
        detail: "KOT print failed",
      });
    }
  };
  const handlePayment = async () => {
    if (!currentOrder) return;
    try {
      const payments = splitMode
        ? splitPayments
        : [
            {
              method: paymentMethod,
              amount:
                paymentMethod === "CASH" ? cashTendered : currentOrder.total,
              reference:
                paymentMethod === "MOBILE_MONEY" ? mobileRef : undefined,
            },
          ];
      const r = await api.post(`/payments/settle/${currentOrder.id}`, {
        payments,
      });
      const change = r.data.change || 0;
      setShowPaymentDialog(false);
      setCurrentOrder(null);
      setSelectedTable(null);
      setCashTendered(0);
      setMobileRef("");
      setSplitPayments([]);
      setSplitMode(false);
      setShowTableDialog(true); // go back to table selection after payment
      await loadTables();
      toast.current?.show({
        severity: "success",
        summary: "Paid!",
        detail:
          change > 0 ? `Change: UGX ${change.toFixed(2)}` : "Order settled",
        life: 3000,
      });
    } catch (err: any) {
      toast.current?.show({
        severity: "error",
        summary: "Payment Failed",
        detail: err.response?.data?.message || "Error",
      });
    }
  };
  const handleTableSelect = async (table: any) => {
    setShowTableDialog(false);
    setSelectedTable(table);
    if (table.orders?.length) {
      // Table has existing active order - load it
      await refreshOrder(table.orders[0].id);
    } else {
      // No order yet - just select the table, DON'T create order yet
      setCurrentOrder(null);
      // Only mark as occupied when first item is added (in addItemToOrder)
    }
  };

  const toggleOrderType = async (type: "DINE_IN" | "TAKEAWAY" | "DELIVERY") => {
    setOrderType(type);
    if (currentOrder) {
      try {
        const r = await api.put(`/orders/${currentOrder.id}/type`, { type });
        setCurrentOrder(r.data);
      } catch {}
    }
  };
  const loadCustomers = async () => {
    try {
      const r = await api.get("/customers", {
        params: { search: customerSearch },
      });
      setCustomers(r.data);
    } catch {}
  };
  const selectCustomer = async (customerId: number | null) => {
    if (!currentOrder) return;
    try {
      const r = await api.put(`/orders/${currentOrder.id}/customer`, {
        customerId,
      });
      setCurrentOrder(r.data);
      setShowCustomerDialog(false);
    } catch {}
  };
  const createCustomer = async () => {
    if (!newCustomerName) return;
    try {
      const r = await api.post("/customers", {
        name: newCustomerName,
        phone: newCustomerPhone,
      });
      await selectCustomer(r.data.id);
      setNewCustomerName("");
      setNewCustomerPhone("");
    } catch {}
  };
  const handleOpenCash = async () => {
    try {
      await api.post("/cash-register/open", {
        userId: user?.id,
        openingAmount,
      });
      setHasOpenShift(true);
      setShowOpenCashDialog(false);
    } catch {}
  };

  const activeItems = currentOrder?.items?.filter((i) => !i.voided) || [];
  const voidedItems = currentOrder?.items?.filter((i) => i.voided) || [];
  const filteredTables =
    tableFilter === "all"
      ? tables
      : tables.filter((t) => t.status?.toLowerCase() === tableFilter);
  const tableCounts = {
    all: tables.length,
    available: tables.filter((t) => t.status?.toLowerCase() === "available")
      .length,
    occupied: tables.filter((t) => t.status?.toLowerCase() === "occupied")
      .length,
    reserved: tables.filter((t) => t.status?.toLowerCase() === "reserved")
      .length,
  };

  const typeIcons: Record<string, string> = {
    DINE_IN: "pi-building",
    TAKEAWAY: "pi-shopping-bag",
    DELIVERY: "pi-truck",
  };
  const typeLabels: Record<string, string> = {
    DINE_IN: "Dine In",
    TAKEAWAY: "Takeaway",
    DELIVERY: "Delivery",
  };

  const savingsCalc = () => {
    if (!currentOrder || !discountValue) return 0;
    return discountType === "percentage"
      ? (currentOrder.subtotal * discountValue) / 100
      : discountValue;
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      className="pos-wrap"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        background: "#eef3f8",
        fontFamily: "'Nunito',sans-serif",
        color: "#2c3e50",
        overflow: "hidden",
      }}
    >
      <Toast ref={toast} position="top-right" />
      <ConfirmDialog />

      {/* ══ TOP BAR ══ */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 20px",
          height: 56,
          background: "#1a7fcf",
          flexShrink: 0,
          boxShadow: "0 2px 12px rgba(26,127,207,.4)",
        }}
      >
        {/* Brand */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontWeight: 900,
            fontSize: 20,
            color: "#fff",
            letterSpacing: "-0.5px",
          }}
        >
          <div
            style={{
              width: 36,
              height: 36,
              background: "rgba(255,255,255,.2)",
              borderRadius: 10,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <i className="pi pi-shop" style={{ color: "#fff", fontSize: 18 }} />
          </div>
          NeuroPOS
        </div>

        {/* Search */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            background: "rgba(255,255,255,.15)",
            borderRadius: 10,
            padding: "0 14px",
            height: 40,
            width: 320,
            border: "1px solid rgba(255,255,255,.25)",
          }}
        >
          <i
            className="pi pi-search"
            style={{ color: "rgba(255,255,255,.7)", fontSize: 14 }}
          />
          <input
            style={{
              border: "none",
              background: "transparent",
              outline: "none",
              flex: 1,
              fontSize: 14,
              color: "#fff",
              fontFamily: "'Nunito',sans-serif",
            }}
            placeholder="Search menu items…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button
              style={{
                border: "none",
                background: "none",
                cursor: "pointer",
                color: "rgba(255,255,255,.7)",
              }}
              onClick={() => setSearchQuery("")}
            >
              <i className="pi pi-times" style={{ fontSize: 12 }} />
            </button>
          )}
        </div>

        {/* Table picker */}
        <button
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 18px",
            borderRadius: 10,
            border: "2px solid rgba(255,255,255,.3)",
            background: selectedTable
              ? "rgba(255,255,255,.25)"
              : "rgba(255,255,255,.1)",
            color: "#fff",
            cursor: "pointer",
            fontSize: 14,
            fontWeight: 700,
            transition: "all .2s",
            fontFamily: "'Nunito',sans-serif",
          }}
          onClick={() => {
            loadTables();
            setShowTableDialog(true);
          }}
        >
          <i className="pi pi-th-large" style={{ fontSize: 15 }} />
          {selectedTable ? `Table T${selectedTable.number}` : "Select Table"}
          {selectedTable && (
            <span
              style={{
                background: "rgba(255,255,255,.25)",
                color: "#fff",
                borderRadius: 6,
                padding: "1px 8px",
                fontSize: 11,
                fontWeight: 800,
              }}
            >
              ACTIVE
            </span>
          )}
        </button>

        {/* Right controls */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              display: "flex",
              background: "rgba(255,255,255,.15)",
              border: "1px solid rgba(255,255,255,.2)",
              borderRadius: 10,
              padding: 3,
              gap: 2,
            }}
          >
            {(["DINE_IN", "TAKEAWAY", "DELIVERY"] as const).map((t) => (
              <button
                key={t}
                className="pos-type-tab"
                style={{
                  background: orderType === t ? "#fff" : "transparent",
                  color: orderType === t ? "#1a7fcf" : "rgba(255,255,255,.85)",
                  boxShadow:
                    orderType === t ? "0 2px 8px rgba(0,0,0,.15)" : "none",
                }}
                onClick={() => toggleOrderType(t)}
              >
                <i className={`pi ${typeIcons[t]}`} style={{ fontSize: 12 }} />
                {typeLabels[t]}
              </button>
            ))}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 14px",
              background: "rgba(255,255,255,.15)",
              border: "1px solid rgba(255,255,255,.2)",
              borderRadius: 20,
              fontSize: 13,
              fontWeight: 600,
              color: "#fff",
            }}
          >
            <i className="pi pi-user" style={{ fontSize: 14 }} />
            {user?.name}
          </div>
          <button
            style={{
              width: 38,
              height: 38,
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,.25)",
              background: "rgba(255,255,255,.1)",
              color: "#fff",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            onClick={logout}
          >
            <i className="pi pi-power-off" style={{ fontSize: 15 }} />
          </button>
        </div>
      </div>

      {/* ══ MAIN ══ */}
      <div
        style={{ display: "flex", flex: 1, overflow: "hidden", minHeight: 0 }}
      >
        {/* ── LEFT: Menus ── */}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            padding: "14px 14px 14px 18px",
            minWidth: 0,
            position: "relative",
          }}
        >
          {/* Category strip */}
          <div
            className="pos-scroll"
            style={{
              display: "flex",
              gap: 8,
              overflowX: "auto",
              paddingBottom: 12,
              flexShrink: 0,
            }}
          >
            <button
              className="pos-cat-pill"
              style={{
                background: !activeCategory ? "#1a7fcf" : "#fff",
                color: !activeCategory ? "#fff" : "#2c3e50",
                border: !activeCategory ? "none" : "1.5px solid #d0e3f0",
                boxShadow: !activeCategory
                  ? "0 3px 10px rgba(26,127,207,.35)"
                  : "none",
              }}
              onClick={() => setActiveCategory(null)}
            >
              🍽️ All Menu
            </button>
            {categories.map((cat) => {
              const color = cat.color || "#1a7fcf";
              const active = activeCategory === cat.id;
              return (
                <button
                  key={cat.id}
                  className="pos-cat-pill"
                  style={{
                    background: active ? color : "#fff",
                    color: active ? "#fff" : "#2c3e50",
                    border: active ? "none" : "1.5px solid #d0e3f0",
                    boxShadow: active ? `0 3px 10px ${color}50` : "none",
                    fontWeight: active ? 800 : 600,
                  }}
                  onClick={() => setActiveCategory(cat.id)}
                >
                  {getCategoryEmoji(cat.name)} {cat.name}
                </button>
              );
            })}
          </div>

          {/* Menus grid */}
          <div
            className="pos-scroll"
            style={{
              flex: 1,
              overflowY: "auto",
              paddingRight: 4,
              paddingBottom: 8,
              minHeight: 0,
            }}
          >
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(185px,1fr))",
                gap: 14,
                alignContent: "start",
              }}
            >
              {filteredMenus.map((menu) => {
                const color = menu.category?.color || "#1a7fcf";
                const imgSrc =
                  (menu as any).imageUrl ||
                  getFoodImage(menu.name, menu.category?.name);
                const locked = !selectedTable;
                return (
                  <div
                    key={menu.id}
                    className={`pos-menu-card${locked ? " locked" : ""}`}
                    onClick={() => !locked && addToOrder(menu)}
                    title={
                      locked ? "Select a table first to start ordering" : ""
                    }
                  >
                    {imgSrc ? (
                      <img
                        src={imgSrc}
                        alt={menu.name}
                        style={{
                          width: "100%",
                          height: 105,
                          objectFit: "cover",
                          display: "block",
                        }}
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = "none";
                          (e.target as HTMLImageElement).nextElementSibling &&
                            (
                              (e.target as HTMLImageElement)
                                .nextElementSibling as HTMLElement
                            ).style.setProperty("display", "flex");
                        }}
                      />
                    ) : null}
                    <div
                      style={{
                        width: "100%",
                        height: 105,
                        background: `linear-gradient(135deg,${color}18,${color}35)`,
                        display: imgSrc ? "none" : "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 44,
                      }}
                    >
                      {getCategoryEmoji(menu.category?.name || "")}
                    </div>
                    <div
                      style={{
                        padding: "10px 13px 13px",
                        display: "flex",
                        flexDirection: "column",
                        flex: 1,
                      }}
                    >
                      <div
                        style={{
                          fontSize: 13,
                          fontWeight: 800,
                          color: "#1e2d3d",
                          lineHeight: "1.35",
                          marginBottom: 8,
                        }}
                      >
                        {menu.name}
                      </div>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          marginTop: "auto",
                        }}
                      >
                        <span style={{ fontSize: 15, fontWeight: 800, color }}>
                          {menu.price}
                        </span>
                        {menu.addOns?.length ? (
                          <span
                            style={{
                              fontSize: 10,
                              background: "#fef3c7",
                              color: "#d97706",
                              padding: "2px 7px",
                              borderRadius: 6,
                              fontWeight: 700,
                            }}
                          >
                            +Addons
                          </span>
                        ) : null}
                        <div
                          style={{
                            width: 28,
                            height: 28,
                            borderRadius: "50%",
                            background: color,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            boxShadow: `0 3px 8px ${color}60`,
                          }}
                        >
                          <i
                            className="pi pi-plus"
                            style={{
                              color: "#fff",
                              fontSize: 12,
                              fontWeight: 700,
                            }}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
              {filteredMenus.length === 0 && (
                <div
                  style={{
                    gridColumn: "1/-1",
                    textAlign: "center",
                    padding: 48,
                    color: "#9baab8",
                  }}
                >
                  <div style={{ fontSize: 44, marginBottom: 8 }}>🔍</div>
                  <p style={{ margin: 0, fontWeight: 700 }}>No menus found</p>
                </div>
              )}
            </div>
          </div>

          {/* TABLE LOCK OVERLAY */}
          {!selectedTable && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                background: "rgba(238,243,248,.88)",
                backdropFilter: "blur(3px)",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 16,
                zIndex: 10,
                borderRadius: 0,
              }}
            >
              <div
                className="lock-pulse"
                style={{
                  width: 80,
                  height: 80,
                  borderRadius: 24,
                  background: "linear-gradient(135deg,#1a7fcf,#1565a8)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  boxShadow: "0 8px 32px rgba(26,127,207,.4)",
                }}
              >
                <i
                  className="pi pi-lock"
                  style={{ fontSize: 36, color: "#fff" }}
                />
              </div>
              <div style={{ textAlign: "center" }}>
                <div
                  style={{
                    fontSize: 22,
                    fontWeight: 900,
                    color: "#1a7fcf",
                    marginBottom: 6,
                  }}
                >
                  Select a Table First
                </div>
                <div
                  style={{ fontSize: 14, color: "#6c7a8d", marginBottom: 20 }}
                >
                  Choose a table to start taking orders
                </div>
                <button
                  className="pos-btn pos-btn-primary"
                  style={{ padding: "12px 32px", fontSize: 15 }}
                  onClick={() => {
                    loadTables();
                    setShowTableDialog(true);
                  }}
                >
                  <i className="pi pi-th-large" /> Browse Tables
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ── RIGHT: Order Panel ── */}
        <div
          style={{
            width: 370,
            background: "#fff",
            borderLeft: "1px solid #d0e3f0",
            display: "flex",
            flexDirection: "column",
            flexShrink: 0,
          }}
        >
          {/* Panel header */}
          <div
            style={{
              padding: "12px 16px 10px",
              borderBottom: "1px solid #e8f3fb",
              background: "#f0f7fd",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <div>
                <div
                  style={{ fontSize: 16, fontWeight: 900, color: "#1a7fcf" }}
                >
                  Order Details
                </div>
                {selectedTable && (
                  <div style={{ fontSize: 12, color: "#6c7a8d", marginTop: 2 }}>
                    Table T{selectedTable.number} ·{" "}
                    {orderType.replace("_", " ")}
                  </div>
                )}
              </div>
              {currentOrder?.customer && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "4px 10px",
                    background: "#e8f3fb",
                    border: "1px solid #b3cfe8",
                    borderRadius: 20,
                    fontSize: 12,
                    fontWeight: 700,
                    color: "#1a7fcf",
                  }}
                >
                  <i className="pi pi-user" style={{ fontSize: 11 }} />
                  {currentOrder.customer.name}
                </div>
              )}
            </div>
          </div>

          {/* Items */}
          <div
            className="pos-scroll"
            style={{ flex: 1, overflowY: "auto", padding: "6px 8px" }}
          >
            {activeItems.length === 0 ? (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  height: "100%",
                  gap: 10,
                  color: "#9baab8",
                  padding: 32,
                }}
              >
                <i
                  className="pi pi-shopping-cart"
                  style={{ fontSize: 44, opacity: 0.25 }}
                />
                <p style={{ margin: 0, fontWeight: 700, color: "#6c7a8d" }}>
                  No items yet
                </p>
                <small style={{ color: "#9baab8" }}>
                  Tap a dish to start your order
                </small>
              </div>
            ) : (
              activeItems.map((item) => {
                const imgSrc =
                  (item.menu as any)?.imageUrl ||
                  getFoodImage(
                    item.menu?.name || "",
                    item.menu?.category?.name,
                  );
                return (
                  <div
                    key={item.id}
                    className={`pos-order-item${item.kotPrinted ? " kot" : ""}`}
                  >
                    {imgSrc ? (
                      <img
                        src={imgSrc}
                        alt={item.menu?.name}
                        style={{
                          width: 36,
                          height: 36,
                          borderRadius: 8,
                          objectFit: "cover",
                          flexShrink: 0,
                        }}
                      />
                    ) : (
                      <div
                        style={{
                          width: 36,
                          height: 36,
                          borderRadius: 8,
                          background: "#e8f3fb",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: 20,
                          flexShrink: 0,
                        }}
                      >
                        {getCategoryEmoji(item.menu?.category?.name || "")}
                      </div>
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 5,
                        }}
                      >
                        <span
                          style={{
                            fontSize: 13,
                            fontWeight: 800,
                            color: "#1e2d3d",
                          }}
                        >
                          {item.menu?.name}
                        </span>
                        {item.kotPrinted && (
                          <i
                            className="pi pi-check-circle"
                            style={{ color: "#16a34a", fontSize: 11 }}
                            title="KOT Sent"
                          />
                        )}
                      </div>
                      {item.addOns && (
                        <div
                          style={{
                            display: "flex",
                            flexWrap: "wrap",
                            gap: 4,
                            marginTop: 3,
                          }}
                        >
                          {JSON.parse(item.addOns).map((a: any) => (
                            <span
                              key={a.id}
                              style={{
                                fontSize: 10,
                                background: "#fef3c7",
                                color: "#a16207",
                                padding: "1px 6px",
                                borderRadius: 5,
                                fontWeight: 700,
                              }}
                            >
                              +{a.name}
                            </span>
                          ))}
                        </div>
                      )}
                      {/* Qty controls */}
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          marginTop: 5,
                        }}
                      >
                        <button
                          style={{
                            width: 24,
                            height: 24,
                            borderRadius: 6,
                            border: "1px solid #d0e3f0",
                            background: "#fff",
                            cursor: "pointer",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: 13,
                            color: "#1a7fcf",
                            fontWeight: 700,
                          }}
                          onClick={() =>
                            updateQuantity(item.id, item.quantity - 1)
                          }
                        >
                          −
                        </button>
                        <span
                          style={{
                            fontSize: 13,
                            fontWeight: 800,
                            minWidth: 20,
                            textAlign: "center",
                            color: "#1e2d3d",
                          }}
                        >
                          {item.quantity}
                        </span>
                        <button
                          style={{
                            width: 24,
                            height: 24,
                            borderRadius: 6,
                            border: "1px solid #d0e3f0",
                            background: "#fff",
                            cursor: "pointer",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: 13,
                            color: "#1a7fcf",
                            fontWeight: 700,
                          }}
                          onClick={() =>
                            updateQuantity(item.id, item.quantity + 1)
                          }
                        >
                          +
                        </button>
                        <button
                          style={{
                            width: 24,
                            height: 24,
                            borderRadius: 6,
                            border: "none",
                            background: "#fff1f0",
                            color: "#dc2626",
                            cursor: "pointer",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: 11,
                            marginLeft: 2,
                          }}
                          onClick={() => voidItem(item.id)}
                          title="Void item"
                        >
                          <i className="pi pi-ban" />
                        </button>
                        <button
                          style={{
                            width: 24,
                            height: 24,
                            borderRadius: 6,
                            border: "none",
                            background: "#f3f4f6",
                            color: "#374151",
                            cursor: "pointer",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: 11,
                          }}
                          onClick={() => removeItem(item.id)}
                          title="Remove"
                        >
                          <i className="pi pi-trash" />
                        </button>
                      </div>
                    </div>
                    <span
                      style={{
                        fontSize: 13,
                        fontWeight: 800,
                        color: "#1a7fcf",
                        flexShrink: 0,
                      }}
                    >
                      {item.totalPrice + item.addOnsTotal}
                    </span>
                  </div>
                );
              })
            )}
            {voidedItems.length > 0 && (
              <>
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 800,
                    color: "#9baab8",
                    textTransform: "uppercase",
                    letterSpacing: 1,
                    margin: "8px 0 4px",
                  }}
                >
                  Voided
                </div>
                {voidedItems.map((item) => (
                  <div key={item.id} className="pos-order-item voided">
                    <span
                      style={{
                        fontSize: 13,
                        fontWeight: 700,
                        textDecoration: "line-through",
                        color: "#9baab8",
                        flex: 1,
                      }}
                    >
                      {item.menu?.name}
                    </span>
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 800,
                        color: "#dc2626",
                        background: "#fee2e2",
                        padding: "2px 8px",
                        borderRadius: 6,
                      }}
                    >
                      VOID
                    </span>
                  </div>
                ))}
              </>
            )}
          </div>

          {/* Summary */}
          <div style={{ padding: "12px 16px", borderTop: "1px solid #e8f3fb" }}>
            {currentOrder ? (
              <>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: 13,
                    color: "#6c7a8d",
                    marginBottom: 5,
                  }}
                >
                  <span>Subtotal</span>
                  <span style={{ fontWeight: 600 }}>
                    UGX {currentOrder.subtotal.toFixed(2)}
                  </span>
                </div>
                {currentOrder.discountAmount > 0 && (
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: 13,
                      color: "#16a34a",
                      marginBottom: 5,
                    }}
                  >
                    <span>Discount</span>
                    <span style={{ fontWeight: 700 }}>
                      − UGX {currentOrder.discountAmount.toFixed(2)}
                    </span>
                  </div>
                )}
                {currentOrder.tax > 0 && (
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: 13,
                      color: "#6c7a8d",
                      marginBottom: 5,
                    }}
                  >
                    <span>Tax</span>
                    <span>UGX {currentOrder.tax.toFixed(2)}</span>
                  </div>
                )}
                <div
                  style={{ height: 1, background: "#d0e3f0", margin: "8px 0" }}
                />
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: 17,
                    fontWeight: 900,
                    color: "#1a7fcf",
                  }}
                >
                  <span>Total</span>
                  <span>UGX {currentOrder.total.toFixed(2)}</span>
                </div>
              </>
            ) : (
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 16,
                  fontWeight: 800,
                  color: "#9baab8",
                }}
              >
                <span>Total</span>
                <span>UGX 0.00</span>
              </div>
            )}
          </div>

          {/* Action buttons */}
          <div
            style={{
              padding: "8px 10px 12px",
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            {/* Row 1 */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr 1fr",
                gap: 8,
              }}
            >
              {ACTION_BTNS.slice(0, 3).map((btn) => {
                const disabled = !currentOrder;
                return (
                  <button
                    key={btn.key}
                    className="pos-action-btn"
                    disabled={disabled}
                    style={{
                      background: disabled ? "#e9eef4" : btn.bg,
                      color: disabled ? "#aab5c2" : "#fff",
                      boxShadow: disabled ? "none" : `0 4px 12px ${btn.shadow}`,
                    }}
                    onClick={() => {
                      if (btn.key === "customer") {
                        loadCustomers();
                        setShowCustomerDialog(true);
                      }
                      if (btn.key === "discount") setShowDiscountDialog(true);
                      if (btn.key === "split") {
                        setSplitMode(true);
                        setShowPaymentDialog(true);
                      }
                    }}
                  >
                    <i className={`pi ${btn.icon}`} style={{ fontSize: 17 }} />
                    <span>{btn.label}</span>
                  </button>
                );
              })}
            </div>
            {/* Row 2 */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr 1fr",
                gap: 8,
              }}
            >
              {ACTION_BTNS.slice(3, 6).map((btn) => {
                const disabled =
                  btn.key === "checkout"
                    ? !currentOrder || activeItems.length === 0
                    : !currentOrder || activeItems.length === 0;
                return (
                  <button
                    key={btn.key}
                    className="pos-action-btn"
                    disabled={disabled}
                    style={{
                      background: disabled ? "#e9eef4" : btn.bg,
                      color: disabled ? "#aab5c2" : "#fff",
                      boxShadow: disabled ? "none" : `0 4px 12px ${btn.shadow}`,
                    }}
                    onClick={() => {
                      if (btn.key === "kot") printKOT();
                      if (btn.key === "bill") setShowBillDialog(true);
                      if (btn.key === "checkout") {
                        setSplitMode(false);
                        setShowPaymentDialog(true);
                      }
                    }}
                  >
                    <i className={`pi ${btn.icon}`} style={{ fontSize: 17 }} />
                    <span>{btn.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* ══════════════════════════════════════════
          DIALOG 1 — TABLE SELECTION (table-first)
      ══════════════════════════════════════════ */}
      <Dialog
        className="pos-dlg"
        header={
          <span>
            <i className="pi pi-th-large" style={{ marginRight: 8 }} />
            Table Selection
          </span>
        }
        visible={showTableDialog}
        onHide={() => !!selectedTable && setShowTableDialog(false)}
        closable={!!selectedTable}
        style={{ width: "860px", maxWidth: "96vw" }}
        contentStyle={{ padding: 0, background: "#f0f7fd" }}
      >
        {/* Filter bar */}
        <div
          style={{
            display: "flex",
            gap: 6,
            padding: "14px 20px 12px",
            background: "#fff",
            borderBottom: "1px solid #d0e3f0",
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <span
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: "#6c7a8d",
              marginRight: 4,
              textTransform: "uppercase",
              letterSpacing: 0.5,
            }}
          >
            Filter:
          </span>
          {[
            {
              key: "all",
              label: "All",
              color: "#1a7fcf",
              count: tableCounts.all,
            },
            {
              key: "available",
              label: "Available",
              color: "#28a745",
              count: tableCounts.available,
            },
            {
              key: "occupied",
              label: "Occupied",
              color: "#fd7e14",
              count: tableCounts.occupied,
            },
            {
              key: "reserved",
              label: "Reserved",
              color: "#007bff",
              count: tableCounts.reserved,
            },
          ].map((f) => (
            <button
              key={f.key}
              onClick={() => setTableFilter(f.key)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "6px 14px",
                borderRadius: 20,
                border: `1.5px solid ${tableFilter === f.key ? f.color : "#d0e3f0"}`,
                background: tableFilter === f.key ? f.color : "#fff",
                color: tableFilter === f.key ? "#fff" : "#6c7a8d",
                fontSize: 12,
                fontWeight: 700,
                cursor: "pointer",
                fontFamily: "'Nunito',sans-serif",
                transition: "all .15s",
              }}
            >
              {f.label}
              <span
                style={{
                  background:
                    tableFilter === f.key ? "rgba(255,255,255,.28)" : "#e8f3fb",
                  color: tableFilter === f.key ? "#fff" : "#1a7fcf",
                  borderRadius: 10,
                  padding: "0 6px",
                  fontSize: 11,
                  fontWeight: 800,
                  minWidth: 18,
                  textAlign: "center",
                }}
              >
                {f.count}
              </span>
            </button>
          ))}
          <button
            style={{
              marginLeft: "auto",
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 14px",
              borderRadius: 20,
              border: "1px solid #d0e3f0",
              background: "#fff",
              color: "#6c7a8d",
              fontSize: 12,
              fontWeight: 700,
              cursor: "pointer",
              fontFamily: "'Nunito',sans-serif",
            }}
            onClick={loadTables}
          >
            <i className="pi pi-refresh" style={{ fontSize: 12 }} /> Refresh
          </button>
        </div>

        {/* Grid */}
        <div
          className="pos-scroll"
          style={{
            padding: "18px 20px 20px",
            overflowY: "auto",
            maxHeight: "calc(90vh - 220px)",
          }}
        >
          {filteredTables.length === 0 ? (
            <div
              style={{
                textAlign: "center",
                padding: "48px 0",
                color: "#9baab8",
              }}
            >
              <div style={{ fontSize: 44, marginBottom: 8 }}>🪑</div>
              <p style={{ margin: 0, fontWeight: 700 }}>No tables found</p>
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(130px,1fr))",
                gap: 14,
              }}
            >
              {filteredTables.map((table) => {
                const cfg = TBL[table.status?.toLowerCase()] || TBL.available;
                const isSelected = selectedTable?.id === table.id;
                const isHovered = hoveredTable === table.id;
                return (
                  <div
                    key={table.id}
                    className="pos-table-card"
                    style={{
                      background: isSelected ? "#e8f3fb" : cfg.bg,
                      border: `2px solid ${isSelected ? "#1a7fcf" : cfg.border}`,
                      boxShadow: isSelected
                        ? "0 0 0 3px rgba(26,127,207,.2), 0 8px 24px rgba(26,127,207,.15)"
                        : isHovered
                          ? "0 8px 24px rgba(26,127,207,.15)"
                          : "0 2px 8px rgba(0,0,0,.05)",
                    }}
                    onClick={() => handleTableSelect(table)}
                    onMouseEnter={() => setHoveredTable(table.id)}
                    onMouseLeave={() => setHoveredTable(null)}
                  >
                    {isSelected && (
                      <div
                        style={{
                          position: "absolute",
                          top: 8,
                          right: 8,
                          width: 20,
                          height: 20,
                          borderRadius: "50%",
                          background: "#1a7fcf",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <i
                          className="pi pi-check"
                          style={{ color: "#fff", fontSize: 10 }}
                        />
                      </div>
                    )}
                    <div
                      style={{
                        fontSize: 26,
                        fontWeight: 900,
                        color: isSelected ? "#1a7fcf" : "#1e2d3d",
                        lineHeight: 1,
                        marginBottom: 6,
                      }}
                    >
                      T{table.number}
                    </div>
                    <div
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        fontSize: 10,
                        fontWeight: 700,
                        padding: "3px 9px",
                        borderRadius: 20,
                        background: `${cfg.dot}18`,
                        color: cfg.dot,
                        border: `1px solid ${cfg.dot}30`,
                      }}
                    >
                      <div
                        style={{
                          width: 5,
                          height: 5,
                          borderRadius: "50%",
                          background: cfg.dot,
                        }}
                      />
                      {cfg.label}
                    </div>
                    {table.zone && (
                      <div
                        style={{
                          fontSize: 10,
                          color: "#9baab8",
                          marginTop: 5,
                          fontWeight: 600,
                        }}
                      >
                        {table.zone}
                      </div>
                    )}
                    {/* {table.orders?.length > 0 && (
                      <div style={{ marginTop:6, fontSize:10, fontWeight:800, color:"#ea580c", background:"#fff7ed", padding:"2px 8px", borderRadius:10, border:"1px solid #fdba74", display:"inline-flex", alignItems:"center", gap:3 }}>
                        <i className="pi pi-receipt" style={{ fontSize:9 }} />{table.orders.length} order{table.orders.length>1?"s":""}
                      </div>
                    )} */}
                  </div>
                );
              })}
            </div>
          )}

          {/* Legend */}
          <div
            style={{
              display: "flex",
              gap: 14,
              justifyContent: "center",
              marginTop: 20,
              paddingTop: 16,
              borderTop: "1px solid #d0e3f0",
              flexWrap: "wrap",
            }}
          >
            {Object.entries(TBL).map(([k, cfg]) => (
              <div
                key={k}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 12,
                  color: "#6c7a8d",
                }}
              >
                <div
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: "50%",
                    background: cfg.dot,
                  }}
                />
                {cfg.label}{" "}
                <span style={{ fontWeight: 800, color: "#2c3e50" }}>
                  ({tables.filter((t) => t.status?.toLowerCase() === k).length})
                </span>
              </div>
            ))}
          </div>
        </div>
      </Dialog>

      {/* ══════════════════════════════════════════
          DIALOG 2 — ADD-ONS  (premium redesign)
      ══════════════════════════════════════════ */}
      <Dialog
        className="pos-dlg"
        header={
          <span>
            <i className="pi pi-star" style={{ marginRight: 8 }} />
            Add-ons — {selectedMenu?.name}
          </span>
        }
        visible={showAddOnDialog}
        onHide={() => setShowAddOnDialog(false)}
        style={{ width: 440 }}
        contentStyle={{ padding: 0 }}
      >
        <div style={{ padding: "20px 20px 0" }}>
          <div
            style={{
              fontSize: 13,
              color: "#6c7a8d",
              marginBottom: 16,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <i className="pi pi-info-circle" style={{ color: "#1a7fcf" }} />
            Select any extras to add to this item
          </div>
          <div>
            {selectedMenu?.addOns?.map((addon) => {
              const checked = selectedAddOns.includes(addon.id);
              return (
                <div
                  key={addon.id}
                  className={`pos-addon-row${checked ? " selected" : ""}`}
                  onClick={() =>
                    setSelectedAddOns(
                      checked
                        ? selectedAddOns.filter((id) => id !== addon.id)
                        : [...selectedAddOns, addon.id],
                    )
                  }
                >
                  <div
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 10,
                      background: checked ? "#1a7fcf" : "#e8f3fb",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                      transition: "background .18s",
                    }}
                  >
                    <i
                      className={`pi ${checked ? "pi-check" : "pi-plus"}`}
                      style={{
                        fontSize: 14,
                        color: checked ? "#fff" : "#1a7fcf",
                      }}
                    />
                  </div>
                  <span
                    style={{
                      flex: 1,
                      fontSize: 14,
                      fontWeight: 700,
                      color: "#1e2d3d",
                    }}
                  >
                    {addon.name}
                  </span>
                  <span
                    style={{
                      fontSize: 15,
                      fontWeight: 900,
                      color: checked ? "#1a7fcf" : "#28a745",
                    }}
                  >
                    +UGX {addon.price.toFixed(2)}
                  </span>
                </div>
              );
            })}
          </div>
          {selectedAddOns.length > 0 && (
            <div
              style={{
                padding: "10px 14px",
                background: "#e8f3fb",
                borderRadius: 10,
                border: "1px solid #b3cfe8",
                marginTop: 8,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span style={{ fontSize: 13, color: "#6c7a8d", fontWeight: 600 }}>
                {selectedAddOns.length} add-on
                {selectedAddOns.length > 1 ? "s" : ""} selected
              </span>
              <span style={{ fontSize: 15, fontWeight: 900, color: "#1a7fcf" }}>
                + UGX
                {(
                  selectedMenu?.addOns
                    ?.filter((a) => selectedAddOns.includes(a.id))
                    .reduce((s, a) => s + a.price, 0) || 0
                ).toFixed(2)}
              </span>
            </div>
          )}
        </div>
        <div
          style={{
            padding: "16px 20px",
            display: "flex",
            gap: 10,
            background: "#f6fafd",
            borderTop: "1px solid #d0e3f0",
            marginTop: 20,
          }}
        >
          <button
            className="pos-btn pos-btn-ghost"
            style={{ flex: 1 }}
            onClick={() => {
              setShowAddOnDialog(false);
              addItemToOrder(selectedMenu!.id);
            }}
          >
            <i className="pi pi-forward" /> Skip Add-ons
          </button>
          <button
            className="pos-btn pos-btn-primary"
            style={{ flex: 2 }}
            onClick={confirmAddOns}
          >
            <i className="pi pi-shopping-cart" /> Add to Order
          </button>
        </div>
      </Dialog>

      {/* ══════════════════════════════════════════
          DIALOG 3 — DISCOUNT  (premium redesign)
      ══════════════════════════════════════════ */}
      <Dialog
        className="pos-dlg"
        header={
          <span>
            <i className="pi pi-percentage" style={{ marginRight: 8 }} />
            Apply Discount
          </span>
        }
        visible={showDiscountDialog}
        onHide={() => setShowDiscountDialog(false)}
        style={{ width: 420 }}
        contentStyle={{ padding: 0 }}
      >
        <div style={{ padding: "20px 20px 0" }}>
          {/* Type toggle */}
          <div
            style={{
              display: "flex",
              background: "#e8f3fb",
              border: "1px solid #b3cfe8",
              borderRadius: 10,
              padding: 4,
              gap: 4,
              marginBottom: 20,
            }}
          >
            {(
              [
                {
                  type: "percentage",
                  icon: "pi-percentage",
                  label: "Percentage",
                },
                { type: "fixed", icon: "pi-dollar", label: "Fixed Amount" },
              ] as const
            ).map((opt) => (
              <button
                key={opt.type}
                className="pos-disc-tab"
                style={{
                  background:
                    discountType === opt.type ? "#1a7fcf" : "transparent",
                  color: discountType === opt.type ? "#fff" : "#6c7a8d",
                  boxShadow:
                    discountType === opt.type
                      ? "0 3px 10px rgba(26,127,207,.3)"
                      : "none",
                }}
                onClick={() => setDiscountType(opt.type)}
              >
                <i className={`pi ${opt.icon}`} style={{ fontSize: 13 }} />{" "}
                {opt.label}
              </button>
            ))}
          </div>

          {/* AdminLTE-style card */}
          <div className="pos-card" style={{ marginBottom: 16 }}>
            <div className="pos-card-header">
              {discountType === "percentage"
                ? "Discount Percentage"
                : "Fixed Discount Amount"}
            </div>
            <div style={{ padding: "20px 18px" }}>
              {/* Big input */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                  marginBottom: 18,
                }}
              >
                {discountType === "fixed" && (
                  <span
                    style={{ fontSize: 32, fontWeight: 900, color: "#1a7fcf" }}
                  >
                    UGX{" "}
                  </span>
                )}
                <InputNumber
                  value={discountValue}
                  onValueChange={(e) => setDiscountValue(e.value ?? 0)}
                  suffix={discountType === "percentage" ? "%" : ""}
                  min={0}
                  max={discountType === "percentage" ? 100 : undefined}
                  placeholder="0"
                  inputStyle={{
                    fontSize: 42,
                    fontWeight: 900,
                    textAlign: "center",
                    border: "none",
                    background: "transparent",
                    color: "#1a7fcf",
                    width: 160,
                    padding: 0,
                    fontFamily: "'Nunito',sans-serif",
                  }}
                  style={{ display: "inline-flex" }}
                />
              </div>
              {/* Quick presets */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr 1fr 1fr",
                  gap: 8,
                }}
              >
                {(discountType === "percentage"
                  ? [5, 10, 15, 20]
                  : [5, 10, 15, 20]
                ).map((v) => (
                  <button
                    key={v}
                    className={`pos-discount-preset${discountValue === v ? " active" : ""}`}
                    onClick={() => setDiscountValue(v)}
                  >
                    {discountType === "percentage" ? `${v}%` : `UGX ${v}`}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Savings preview */}
          {discountValue > 0 && currentOrder && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "12px 16px",
                background: "#f0fdf4",
                border: "1px solid #86efac",
                borderRadius: 10,
                marginBottom: 4,
              }}
            >
              <span
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 13,
                  fontWeight: 700,
                  color: "#15803d",
                }}
              >
                <i className="pi pi-check-circle" style={{ fontSize: 16 }} />{" "}
                Customer saves
              </span>
              <span style={{ fontSize: 18, fontWeight: 900, color: "#15803d" }}>
                ${savingsCalc().toFixed(2)}
              </span>
            </div>
          )}
        </div>

        <div
          style={{
            padding: "16px 20px",
            display: "flex",
            gap: 10,
            background: "#f6fafd",
            borderTop: "1px solid #d0e3f0",
            marginTop: 20,
          }}
        >
          <button
            className="pos-btn pos-btn-danger"
            style={{ flex: 1 }}
            disabled={!currentOrder?.discountAmount}
            onClick={() => {
              setDiscountValue(0);
              applyDiscount();
            }}
          >
            <i className="pi pi-trash" /> Remove
          </button>
          <button
            className="pos-btn pos-btn-primary"
            style={{ flex: 2 }}
            disabled={discountValue === 0}
            onClick={() => {
              if (discountValue > 0) applyDiscount();
            }}
          >
            <i className="pi pi-check" /> Apply Discount
          </button>
        </div>
      </Dialog>

      {/* ══════════════════════════════════════════
          DIALOG 4 — CUSTOMER  (premium redesign)
      ══════════════════════════════════════════ */}
      <Dialog
        className="pos-dlg"
        header={
          <span>
            <i className="pi pi-users" style={{ marginRight: 8 }} />
            Select Customer
          </span>
        }
        visible={showCustomerDialog}
        onHide={() => setShowCustomerDialog(false)}
        style={{ width: 520 }}
        contentStyle={{ padding: 0 }}
      >
        <div style={{ padding: "20px 20px 0" }}>
          {/* Search */}
          <div className="pos-input-icon" style={{ marginBottom: 14 }}>
            <i className="pi pi-search" />
            <input
              className="pos-input"
              style={{ paddingLeft: 38 }}
              value={customerSearch}
              onChange={(e) => setCustomerSearch(e.target.value)}
              placeholder="Search by name or phone…"
              onKeyUp={loadCustomers}
            />
          </div>

          {/* Customer list */}
          <div className="pos-card" style={{ marginBottom: 16 }}>
            <div className="pos-card-header">Existing Customers</div>
            <div
              className="pos-scroll"
              style={{
                maxHeight: 220,
                overflowY: "auto",
                padding: "10px 12px",
              }}
            >
              {customers.length === 0 ? (
                <div
                  style={{
                    textAlign: "center",
                    padding: "24px 0",
                    color: "#9baab8",
                  }}
                >
                  <i
                    className="pi pi-search"
                    style={{ fontSize: 30, marginBottom: 8 }}
                  />
                  <div style={{ fontSize: 13, fontWeight: 600 }}>
                    No customers found
                  </div>
                  <div style={{ fontSize: 12, marginTop: 4 }}>
                    Try a different search or add new below
                  </div>
                </div>
              ) : (
                customers.map((c) => (
                  <div
                    key={c.id}
                    className="pos-cust-row"
                    onClick={() => selectCustomer(c.id)}
                  >
                    <div
                      style={{
                        width: 42,
                        height: 42,
                        borderRadius: 12,
                        background: "#1a7fcf",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                      }}
                    >
                      <i
                        className="pi pi-user"
                        style={{ fontSize: 18, color: "#fff" }}
                      />
                    </div>
                    <div style={{ flex: 1 }}>
                      <div
                        style={{
                          fontSize: 14,
                          fontWeight: 800,
                          color: "#1e2d3d",
                        }}
                      >
                        {c.name}
                      </div>
                      {c.phone && (
                        <div
                          style={{
                            fontSize: 12,
                            color: "#6c7a8d",
                            marginTop: 2,
                          }}
                        >
                          <i
                            className="pi pi-phone"
                            style={{ fontSize: 11, marginRight: 5 }}
                          />
                          {c.phone}
                        </div>
                      )}
                    </div>
                    <i
                      className="pi pi-chevron-right"
                      style={{ color: "#9baab8", fontSize: 14 }}
                    />
                  </div>
                ))
              )}
            </div>
          </div>

          {/* New customer */}
          <div className="pos-card" style={{ marginBottom: 4 }}>
            <div className="pos-card-header">Add New Customer</div>
            <div
              style={{
                padding: "14px 16px",
                display: "flex",
                flexDirection: "column",
                gap: 10,
              }}
            >
              <div className="pos-input-icon">
                <i className="pi pi-user" />
                <input
                  className="pos-input"
                  style={{ paddingLeft: 38 }}
                  value={newCustomerName}
                  onChange={(e) => setNewCustomerName(e.target.value)}
                  placeholder="Full name *"
                />
              </div>
              <div className="pos-input-icon">
                <i className="pi pi-phone" />
                <input
                  className="pos-input"
                  style={{ paddingLeft: 38 }}
                  value={newCustomerPhone}
                  onChange={(e) => setNewCustomerPhone(e.target.value)}
                  placeholder="Phone number"
                />
              </div>
            </div>
          </div>
        </div>

        <div
          style={{
            padding: "14px 20px",
            display: "flex",
            gap: 10,
            background: "#f6fafd",
            borderTop: "1px solid #d0e3f0",
            marginTop: 16,
          }}
        >
          {currentOrder?.customer && (
            <button
              className="pos-btn pos-btn-danger"
              style={{ flex: 1 }}
              onClick={() => selectCustomer(null)}
            >
              <i className="pi pi-user-minus" /> Remove
            </button>
          )}
          <button
            className="pos-btn pos-btn-ghost"
            style={{ flex: 1 }}
            onClick={() => setShowCustomerDialog(false)}
          >
            <i className="pi pi-times" /> Cancel
          </button>
          <button
            className="pos-btn pos-btn-primary"
            style={{ flex: 2 }}
            disabled={!newCustomerName.trim()}
            onClick={createCustomer}
          >
            <i className="pi pi-user-plus" /> Create & Select
          </button>
        </div>
      </Dialog>

      {/* ══════════════════════════════════════════
          DIALOG — PAYMENT
      ══════════════════════════════════════════ */}
      <Dialog
        className="pos-dlg"
        header={
          <span>
            <i className="pi pi-wallet" style={{ marginRight: 8 }} />
            Checkout
          </span>
        }
        visible={showPaymentDialog}
        onHide={() => setShowPaymentDialog(false)}
        style={{ width: 480 }}
        contentStyle={{ padding: 0 }}
      >
        <div style={{ padding: "20px" }}>
          {/* Total */}
          <div
            style={{
              textAlign: "center",
              padding: "18px 16px",
              background: "linear-gradient(135deg,#1a7fcf,#1565a8)",
              borderRadius: 12,
              marginBottom: 18,
            }}
          >
            <div
              style={{
                fontSize: 12,
                color: "rgba(255,255,255,.7)",
                marginBottom: 4,
                fontWeight: 700,
                letterSpacing: 0.5,
                textTransform: "uppercase",
              }}
            >
              Total Due
            </div>
            <div style={{ fontSize: 38, fontWeight: 900, color: "#fff" }}>
              UGX {currentOrder?.total.toFixed(2)}
            </div>
          </div>

          {/* Split toggle */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "11px 14px",
              background: "#f0f7fd",
              border: "1px solid #b3cfe8",
              borderRadius: 10,
              marginBottom: 16,
            }}
          >
            <Checkbox
              inputId="split-mode"
              checked={splitMode}
              onChange={(e) => setSplitMode(e.checked || false)}
            />
            <label
              htmlFor="split-mode"
              style={{
                cursor: "pointer",
                fontWeight: 700,
                fontSize: 14,
                color: "#2c3e50",
              }}
            >
              Split Payment
            </label>
          </div>

          {/* Payment method */}
          <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
            {[
              { val: "CASH", icon: "pi-money-bill", label: "Cash" },
              { val: "MOBILE_MONEY", icon: "pi-mobile", label: "Mobile Money" },
            ].map((m) => (
              <div
                key={m.val}
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "12px 14px",
                  borderRadius: 10,
                  cursor: "pointer",
                  border: `2px solid ${paymentMethod === m.val ? "#1a7fcf" : "#d0e3f0"}`,
                  background: paymentMethod === m.val ? "#e8f3fb" : "#f9fafb",
                  transition: "all .18s",
                }}
                onClick={() => setPaymentMethod(m.val as any)}
              >
                <RadioButton
                  value={m.val}
                  checked={paymentMethod === m.val}
                  onChange={(e) => setPaymentMethod(e.value)}
                />
                <i
                  className={`pi ${m.icon}`}
                  style={{
                    color: paymentMethod === m.val ? "#1a7fcf" : "#6c7a8d",
                    fontSize: 16,
                  }}
                />
                <span
                  style={{
                    fontWeight: 700,
                    fontSize: 14,
                    color: paymentMethod === m.val ? "#1a7fcf" : "#2c3e50",
                  }}
                >
                  {m.label}
                </span>
              </div>
            ))}
          </div>

          {/* Cash inputs */}
          {!splitMode ? (
            paymentMethod === "CASH" ? (
              <>
                <div style={{ marginBottom: 12 }}>
                  <label
                    style={{
                      fontSize: 13,
                      fontWeight: 700,
                      color: "#2c3e50",
                      display: "block",
                      marginBottom: 6,
                    }}
                  >
                    Cash Tendered
                  </label>
                  <InputNumber
                    value={cashTendered}
                    onValueChange={(e) => setCashTendered(e.value || 0)}
                    mode="currency"
                    currency="USD"
                    className="w-full"
                  />
                </div>
                {cashTendered > 0 && currentOrder && (
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      padding: "10px 14px",
                      borderRadius: 10,
                      background:
                        cashTendered >= currentOrder.total
                          ? "#f0fdf4"
                          : "#fff1f0",
                      border: `1px solid ${cashTendered >= currentOrder.total ? "#86efac" : "#fecaca"}`,
                      marginBottom: 12,
                    }}
                  >
                    <span style={{ fontWeight: 700, fontSize: 14 }}>
                      Change
                    </span>
                    <span
                      style={{
                        fontWeight: 900,
                        fontSize: 16,
                        color:
                          cashTendered >= currentOrder.total
                            ? "#16a34a"
                            : "#dc2626",
                      }}
                    >
                      UGX {(cashTendered - currentOrder.total).toFixed(2)}
                    </span>
                  </div>
                )}
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 8,
                    marginBottom: 12,
                  }}
                >
                  {[10, 20, 50, 100].map((amt) => (
                    <button
                      key={amt}
                      style={{
                        flex: "1 1 auto",
                        padding: "8px 0",
                        borderRadius: 8,
                        border: "1px solid #d0e3f0",
                        background: "#fff",
                        color: "#2c3e50",
                        cursor: "pointer",
                        fontWeight: 700,
                        fontSize: 14,
                        fontFamily: "'Nunito',sans-serif",
                      }}
                      onClick={() => setCashTendered(amt)}
                    >
                      UGX {amt}
                    </button>
                  ))}
                  {currentOrder && (
                    <button
                      style={{
                        flex: "1 1 auto",
                        padding: "8px 0",
                        borderRadius: 8,
                        border: "2px solid #1a7fcf",
                        background: "#e8f3fb",
                        color: "#1a7fcf",
                        cursor: "pointer",
                        fontWeight: 800,
                        fontSize: 14,
                        fontFamily: "'Nunito',sans-serif",
                      }}
                      onClick={() => setCashTendered(currentOrder.total)}
                    >
                      Exact
                    </button>
                  )}
                </div>
              </>
            ) : (
              <div style={{ marginBottom: 12 }}>
                <label
                  style={{
                    fontSize: 13,
                    fontWeight: 700,
                    color: "#2c3e50",
                    display: "block",
                    marginBottom: 6,
                  }}
                >
                  Transaction Reference
                </label>
                <InputText
                  value={mobileRef}
                  onChange={(e) => setMobileRef(e.target.value)}
                  placeholder="Enter reference number"
                  className="w-full"
                />
              </div>
            )
          ) : (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                marginBottom: 12,
              }}
            >
              <div style={{ display: "flex", gap: 8 }}>
                <InputNumber
                  value={splitAmount}
                  onValueChange={(e) => setSplitAmount(e.value || 0)}
                  mode="currency"
                  currency="USD"
                  placeholder="Amount"
                  className="flex-1"
                />
                {paymentMethod === "MOBILE_MONEY" && (
                  <InputText
                    value={mobileRef}
                    onChange={(e) => setMobileRef(e.target.value)}
                    placeholder="Ref"
                    className="flex-1"
                  />
                )}
                <Button
                  icon="pi pi-plus"
                  className="p-button-primary"
                  onClick={() => {
                    if (splitAmount <= 0) return;
                    setSplitPayments([
                      ...splitPayments,
                      {
                        method: paymentMethod,
                        amount: splitAmount,
                        reference:
                          paymentMethod === "MOBILE_MONEY"
                            ? mobileRef
                            : undefined,
                      },
                    ]);
                    setSplitAmount(0);
                    setMobileRef("");
                  }}
                />
              </div>
              {splitPayments.map((sp, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 12px",
                    background: "#f0f7fd",
                    border: "1px solid #b3cfe8",
                    borderRadius: 8,
                  }}
                >
                  <span>
                    {sp.method === "CASH" ? "💵" : "📱"} {sp.method}
                  </span>
                  <span style={{ marginLeft: "auto", fontWeight: 800 }}>
                    UGX {sp.amount.toFixed(2)}
                  </span>
                  <button
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: 6,
                      border: "none",
                      background: "#f3f4f6",
                      color: "#374151",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                    onClick={() =>
                      setSplitPayments(splitPayments.filter((_, j) => j !== i))
                    }
                  >
                    <i className="pi pi-times" style={{ fontSize: 11 }} />
                  </button>
                </div>
              ))}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 13,
                  color: "#6c7a8d",
                  fontWeight: 600,
                }}
              >
                <span>
                  Paid: UGX{" "}
                  {splitPayments.reduce((s, p) => s + p.amount, 0).toFixed(2)}
                </span>
                <span>
                  Remaining: UGX{" "}
                  {(
                    (currentOrder?.total || 0) -
                    splitPayments.reduce((s, p) => s + p.amount, 0)
                  ).toFixed(2)}
                </span>
              </div>
            </div>
          )}

          <button
            className="pos-btn pos-btn-success"
            style={{
              width: "100%",
              padding: "14px 0",
              fontSize: 16,
              borderRadius: 12,
            }}
            disabled={
              !splitMode
                ? paymentMethod === "CASH"
                  ? cashTendered < (currentOrder?.total || 0)
                  : !mobileRef
                : splitPayments.reduce((s, p) => s + p.amount, 0) <
                  (currentOrder?.total || 0)
            }
            onClick={handlePayment}
          >
            <i className="pi pi-check" /> Complete Payment
          </button>
        </div>
      </Dialog>

      {/* ══════════════════════════════════════════
          DIALOG — OPEN CASH
      ══════════════════════════════════════════ */}
      <Dialog
        className="pos-dlg"
        header={
          <span>
            <i className="pi pi-lock-open" style={{ marginRight: 8 }} />
            Open Cash Register
          </span>
        }
        visible={showOpenCashDialog}
        onHide={() => hasOpenShift && setShowOpenCashDialog(false)}
        closable={hasOpenShift}
        style={{ width: 380 }}
        contentStyle={{ padding: 0 }}
      >
        <div
          style={{
            padding: 24,
            display: "flex",
            flexDirection: "column",
            gap: 16,
          }}
        >
          <p style={{ color: "#6c7a8d", margin: 0, fontSize: 14 }}>
            Enter the opening cash amount for your shift:
          </p>
          <InputNumber
            value={openingAmount}
            onValueChange={(e) => setOpeningAmount(e.value || 0)}
            mode="currency"
            currency="USD"
            className="w-full"
          />
          <Button
            label="Open Shift"
            icon="pi pi-lock-open"
            className="w-full p-button-primary"
            onClick={handleOpenCash}
          />
        </div>
      </Dialog>

      {/* ══════════════════════════════════════════
          DIALOG — BILL / RECEIPT
      ══════════════════════════════════════════ */}
      <Dialog
        className="pos-dlg"
        header={
          <span>
            <i className="pi pi-file-pdf" style={{ marginRight: 8 }} />
            Receipt Preview
          </span>
        }
        visible={showBillDialog}
        onHide={() => setShowBillDialog(false)}
        style={{ width: 460 }}
        contentStyle={{ padding: 0 }}
      >
        {currentOrder && (
          <div
            style={{
              padding: "24px 28px 28px",
              fontFamily: "'Courier New',monospace",
              fontSize: 14,
              color: "#1e2d3d",
            }}
          >
            <div style={{ textAlign: "center", marginBottom: 24 }}>
              <div
                style={{
                  fontSize: 22,
                  fontWeight: 900,
                  color: "#1a7fcf",
                  fontFamily: "'Nunito',sans-serif",
                }}
              >
                Ruta Pub
              </div>
              <div style={{ fontSize: 12, color: "#6c7a8d", marginTop: 4 }}>
                #{currentOrder.orderNumber} ·{" "}
                {new Date().toLocaleString("en-US", {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </div>
              {currentOrder.table && (
                <div style={{ fontSize: 13, marginTop: 6 }}>
                  Table T{currentOrder.table.number}
                </div>
              )}
              {currentOrder.customer && (
                <div style={{ fontSize: 13, marginTop: 2 }}>
                  Guest: {currentOrder.customer.name}
                </div>
              )}
            </div>
            <div
              style={{
                borderTop: "2px dashed #d0e3f0",
                borderBottom: "2px dashed #d0e3f0",
                padding: "16px 0",
                marginBottom: 18,
              }}
            >
              {activeItems.map((item) => (
                <div
                  key={item.id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    marginBottom: 10,
                  }}
                >
                  <div style={{ flex: 1 }}>
                    <div>
                      {item.quantity} × {item.menu?.name}
                    </div>
                    {item.addOns && JSON.parse(item.addOns).length > 0 && (
                      <div
                        style={{ fontSize: 12, color: "#6c7a8d", marginTop: 3 }}
                      >
                        +{" "}
                        {JSON.parse(item.addOns)
                          .map((a: any) => a.name)
                          .join(", ")}
                      </div>
                    )}
                  </div>
                  <div
                    style={{
                      fontWeight: 700,
                      minWidth: 80,
                      textAlign: "right",
                    }}
                  >
                    UGX {(item.totalPrice + item.addOnsTotal).toFixed(2)}
                  </div>
                </div>
              ))}
            </div>
            <div style={{ marginBottom: 16 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  marginBottom: 8,
                }}
              >
                <span>Subtotal</span>
                <span>UGX {currentOrder.subtotal.toFixed(2)}</span>
              </div>
              {currentOrder.discountAmount > 0 && (
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    marginBottom: 8,
                    color: "#16a34a",
                    fontWeight: 700,
                  }}
                >
                  <span>Discount</span>
                  <span>− UGX {currentOrder.discountAmount.toFixed(2)}</span>
                </div>
              )}
              {currentOrder.tax > 0 && (
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    marginBottom: 8,
                  }}
                >
                  <span>Tax</span>
                  <span>${currentOrder.tax.toFixed(2)}</span>
                </div>
              )}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 18,
                  fontWeight: 900,
                  marginTop: 12,
                  paddingTop: 12,
                  borderTop: "2px solid #d0e3f0",
                  fontFamily: "'Nunito',sans-serif",
                }}
              >
                <span>TOTAL</span>
                <span style={{ color: "#1a7fcf" }}>
                  UGX {currentOrder.total.toFixed(2)}
                </span>
              </div>
            </div>
            <div
              style={{
                textAlign: "center",
                color: "#6c7a8d",
                fontSize: 13,
                marginBottom: 24,
              }}
            >
              Thank you for dining with us! 🍽️
              <br />
              Come back soon!
            </div>
            <button
              className="pos-btn pos-btn-primary"
              style={{
                width: "100%",
                padding: "14px 0",
                fontSize: 15,
                borderRadius: 12,
              }}
              onClick={() => window.print()}
            >
              <i className="pi pi-print" /> Print Receipt
            </button>
          </div>
        )}
      </Dialog>
    </div>
  );
};

export default POSPage;
