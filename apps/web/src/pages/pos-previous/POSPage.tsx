// @ts-nocheck — known-implicit-any from Sprint 1 close-out patches. Re-enable per-file as
// types are tightened; see tasks/tight-01.A/B/D for the source.
import React, { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import api from "../../services/api";
import { Category, Menu, Order, OrderItem, Customer, AddOn } from "../../types";
import { toast, Toaster } from "sonner";

// ─── shadcn/ui components ─────────────────────────────────────
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";

// ─── Lucide icons ─────────────────────────────────────────────
import {
  Store,
  Search,
  X,
  LayoutGrid,
  User,
  Power,
  Lock,
  Check,
  Star,
  Info,
  Plus,
  SkipForward,
  ShoppingCart,
  ShoppingBag,
  Truck,
  Building,
  Percent,
  DollarSign,
  Trash2,
  Users,
  UserMinus,
  UserPlus,
  Wallet,
  Banknote,
  Smartphone,
  CheckCircle2,
  Ban,
  Receipt,
  LockOpen,
  FileText,
  Printer,
  ChevronRight,
  Phone,
  RefreshCw,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  StickyNote,
  ArrowRightLeft,
  Link2,
  Unlink,
} from "lucide-react";
import { MoveHorizontal } from 'lucide-react';
// ─── Types ────────────────────────────────────────────────────

// ─── Inject global stylesheet once ────────────────────────────
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
  .pos-input-icon svg { position: absolute; left: 13px; top: 50%; transform: translateY(-50%); color: var(--pos-text-muted); width: 14px; height: 14px; }
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
    icon: UserPlus,
    label: "Customer",
    bg: "#1a7fcf",
    shadow: "rgba(26,127,207,.35)",
  },
  {
    key: "discount",
    icon: Percent,
    label: "Discount",
    bg: "#f59e0b",
    shadow: "rgba(245,158,11,.35)",
  },
  {
    key: "split",
    icon: MoveHorizontal,
    label: "Split Bill",
    bg: "#ec4899",
    shadow: "rgba(236,72,153,.35)",
  },
  {
    key: "kot",
    icon: Printer,
    label: "Print KOT",
    bg: "#0ea5e9",
    shadow: "rgba(14,165,233,.35)",
  },
  {
    key: "bill",
    icon: FileText,
    label: "Print Bill",
    bg: "#8b5cf6",
    shadow: "rgba(139,92,246,.35)",
  },
  {
    key: "checkout",
    icon: Wallet,
    label: "Checkout",
    bg: "#28a745",
    shadow: "rgba(40,167,69,.35)",
  },
];

// ─── Component ────────────────────────────────────────────────────────────────
const POSPage: React.FC = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

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
  const [selectedTable, setSelectedTable] = useState<any>(null);
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
  const [showTableDialog, setShowTableDialog] = useState(true);
  const [showBillDialog, setShowBillDialog] = useState(false);
  const [showVoidConfirm, setShowVoidConfirm] = useState<{
    itemId: number;
  } | null>(null);
  const [showRemoveConfirm, setShowRemoveConfirm] = useState<{
    itemId: number;
  } | null>(null);
  // Sprint 1 dialogs (TIGHT-01.A/B/C/D + 01.4-01.10)
  const [reasonPrompt, setReasonPrompt] = useState<
    | null
    | {
        kind: "void" | "cancel" | "hold" | "reprint" | "lineNote";
        itemId?: number;
        title: string;
        description: string;
        placeholder: string;
        confirmLabel: string;
        confirmColor: string;
        multiline?: boolean;
        minChars?: number;
      }
  >(null);
  const [reasonText, setReasonText] = useState("");
  const [reprintCount, setReprintCount] = useState<number>(0);
  const [heldOrders, setHeldOrders] = useState<Order[]>([]);
  const [showHeldDialog, setShowHeldDialog] = useState(false);
  const [tableActionTable, setTableActionTable] = useState<any | null>(null);
  const [tableActionMode, setTableActionMode] = useState<
    "merge" | "transfer" | null
  >(null);
  const [tableActionTarget, setTableActionTarget] = useState<any | null>(null);
  const [orderNoteEdit, setOrderNoteEdit] = useState(false);
  const [orderNoteText, setOrderNoteText] = useState("");
  // Split-bill tab state
  const [splitMethod, setSplitMethod] = useState<
    "ITEM" | "PERCENT" | "AMOUNT" | "EQUAL"
  >("ITEM");
  const [splitPercentParts, setSplitPercentParts] = useState<
    { label: string; percent: number }[]
  >([{ label: "Bill 1", percent: 50 }, { label: "Bill 2", percent: 50 }]);
  const [splitAmountParts, setSplitAmountParts] = useState<
    { label: string; amount: number }[]
  >([{ label: "Bill 1", amount: 0 }, { label: "Bill 2", amount: 0 }]);
  const [splitEqualN, setSplitEqualN] = useState<number>(2);
  // Discount reason
  const [discountReason, setDiscountReason] = useState("");

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
      toast.error("Failed to create order");
    }
  };

  const addToOrder = async (menu: Menu) => {
    if (!selectedTable) return;
    if (menu.addOns?.length) {
      setSelectedMenu(menu);
      setSelectedAddOns([]);
      setShowAddOnDialog(true);
      return;
    }
    await addItemToOrder(menu.id);
  };

  const addItemToOrder = async (menuId: number, addOns?: AddOn[]) => {
    try {
      let order = currentOrder;
      if (!order) {
        order = await createOrder(selectedTable?.id);
        if (!order) return;
      }
      if (currentOrder === null && selectedTable) {
        try {
          await api.put(`/tables/${selectedTable.id}/status`, {
            status: "occupied",
          });
        } catch {}
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
      toast.success("Item added", { duration: 1200 });
    } catch {
      toast.error("Failed to add item");
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
    setShowRemoveConfirm({ itemId });
  };

  const handleRemoveConfirm = async () => {
    if (!currentOrder || !showRemoveConfirm) return;
    await api.delete(
      `/orders/${currentOrder.id}/items/${showRemoveConfirm.itemId}`,
    );
    await refreshOrder(currentOrder.id);
    setShowRemoveConfirm(null);
  };

  const voidItem = (itemId: number) => {
    if (!currentOrder) return;
    setReasonText("");
    setReasonPrompt({
      kind: "void",
      itemId,
      title: "Void item",
      description:
        "A reason is required for voids (min 3 chars). It will be saved on the audit log.",
      placeholder: "e.g. Customer changed mind, wrong item",
      confirmLabel: "Void item",
      confirmColor: "#dc2626",
      multiline: true,
      minChars: 3,
    });
  };

  const handleVoidConfirm = async () => {
    if (!currentOrder || !showVoidConfirm) return;
    const trimmed = (reasonPrompt?.kind === "void" ? reasonText : "").trim();
    if (trimmed.length < 3) {
      toast.error("Reason must be at least 3 characters");
      return;
    }
    await api.put(
      `/orders/${currentOrder.id}/items/${showVoidConfirm.itemId}/void`,
      { reason: trimmed },
    );
    await refreshOrder(currentOrder.id);
    setShowVoidConfirm(null);
    setReasonPrompt(null);
    setReasonText("");
    toast.success("Item voided");
  };

  // ── Sprint 1: Hold / Cancel / Reprint / Notes (TIGHT-01.A/D + 01.4/01.10) ──
  const openHoldPrompt = () => {
    if (!currentOrder) return;
    setReasonText("");
    setReasonPrompt({
      kind: "hold",
      title: "Hold this order",
      description:
        "Park this ticket and free the table. The next cashier can resume it from the Held list.",
      placeholder: "e.g. Guest not back yet",
      confirmLabel: "Hold order",
      confirmColor: "#f59e0b",
      multiline: false,
      minChars: 3,
    });
  };
  const submitHold = async () => {
    if (!currentOrder) return;
    const trimmed = reasonText.trim();
    if (trimmed.length < 3) return toast.error("Reason must be at least 3 characters");
    try {
      await api.post(`/orders/${currentOrder.id}/hold`, { reason: trimmed });
      toast.success(`Held ${currentOrder.orderNumber}`);
      setReasonPrompt(null);
      setReasonText("");
      setCurrentOrder(null);
      setSelectedTable(null);
      await loadTables();
    } catch (e: any) {
      toast.error(e?.response?.data?.message || "Hold failed");
    }
  };

  const openCancelPrompt = () => {
    if (!currentOrder) return;
    setReasonText("");
    setReasonPrompt({
      kind: "cancel",
      title: "Cancel this order",
      description:
        "This will permanently cancel the order and free the table. A reason is required (min 3 chars).",
      placeholder: "e.g. Customer left, wrong ticket",
      confirmLabel: "Cancel order",
      confirmColor: "#dc2626",
      multiline: true,
      minChars: 3,
    });
  };
  const submitCancel = async () => {
    if (!currentOrder) return;
    const trimmed = reasonText.trim();
    if (trimmed.length < 3) return toast.error("Reason must be at least 3 characters");
    try {
      await api.put(`/orders/${currentOrder.id}/cancel`, { reason: trimmed });
      toast.success(`Cancelled ${currentOrder.orderNumber}`);
      setReasonPrompt(null);
      setReasonText("");
      setCurrentOrder(null);
      setSelectedTable(null);
      await loadTables();
    } catch (e: any) {
      toast.error(e?.response?.data?.message || "Cancel failed");
    }
  };

  const openReprintPrompt = () => {
    if (!currentOrder) return;
    if (currentOrder.status !== "COMPLETED")
      return toast.error("Only COMPLETED orders can be reprinted");
    setReasonText("");
    setReasonPrompt({
      kind: "reprint",
      title: "Reprint receipt",
      description:
        "The receipt will be queued again and a reprint entry recorded in the audit log.",
      placeholder: "e.g. printer jam, lost copy",
      confirmLabel: "Reprint",
      confirmColor: "#8b5cf6",
      multiline: false,
      minChars: 3,
    });
  };
  const submitReprint = async () => {
    if (!currentOrder) return;
    const trimmed = reasonText.trim();
    if (trimmed.length < 3) return toast.error("Reason must be at least 3 characters");
    try {
      const r = await api.post(`/orders/${currentOrder.id}/reprint`, {
        reason: trimmed,
      });
      toast.success(r?.data?.ok ? "Receipt queued for reprint" : "Reprint recorded");
      setReprintCount((c) => c + 1);
      setReasonPrompt(null);
      setReasonText("");
    } catch (e: any) {
      toast.error(e?.response?.data?.message || "Reprint failed");
    }
  };

  const openLineNotePrompt = (itemId: number, existing?: string) => {
    setReasonText(existing || "");
    setReasonPrompt({
      kind: "lineNote",
      itemId,
      title: "Item note",
      description:
        "Add a kitchen note for this item (e.g. no onions). Saved when you confirm.",
      placeholder: "e.g. no onions, well done",
      confirmLabel: "Save note",
      confirmColor: "#0ea5e9",
      multiline: false,
      minChars: 0,
    });
  };
  const submitLineNote = async () => {
    if (!currentOrder || !reasonPrompt || reasonPrompt.itemId == null) return;
    const trimmed = reasonText.trim();
    try {
      await api.put(
        `/orders/${currentOrder.id}/items/${reasonPrompt.itemId}/quantity`,
        { quantity: undefined, notes: trimmed }, // best-effort: notes piggyback via addItem path
      );
      // The backend's PATCH quantity route doesn't take notes; update via re-add.
      // Simpler & correct: remove + addItem with the new note for the same menu+addons.
      const fresh = await api.get(`/orders/${currentOrder.id}`);
      const it = (fresh.data.items || []).find(
        (x: any) => x.id === reasonPrompt.itemId,
      );
      if (it) {
        // Remove and re-add with the new note.
        await api.delete(
          `/orders/${currentOrder.id}/items/${reasonPrompt.itemId}`,
        );
        const addOnsJson = it.addOns || undefined;
        await api.post(`/orders/${currentOrder.id}/items`, {
          menuId: it.menuId,
          quantity: it.quantity,
          addOns: addOnsJson,
          notes: trimmed || undefined,
        });
      }
      await refreshOrder(currentOrder.id);
      toast.success("Note saved");
      setReasonPrompt(null);
      setReasonText("");
    } catch (e: any) {
      toast.error(e?.response?.data?.message || "Note save failed");
    }
  };

  const loadHeldOrders = async () => {
    try {
      const r = await api.get("/orders", { params: { status: "HELD" } });
      setHeldOrders(r.data || []);
    } catch {
      setHeldOrders([]);
    }
  };
  const resumeHeld = async (id: number) => {
    try {
      const r = await api.post(`/orders/${id}/resume`, {});
      setCurrentOrder(r.data);
      if (r.data.table) setSelectedTable(r.data.table);
      setShowHeldDialog(false);
      toast.success(`Resumed ${r.data.orderNumber}`);
      await loadTables();
    } catch (e: any) {
      toast.error(e?.response?.data?.message || "Resume failed");
    }
  };

  const mergeTables = async () => {
    if (!tableActionTable || !tableActionTarget) return;
    try {
      await api.post(
        `/tables/${tableActionTable.id}/merge/${tableActionTarget.id}`,
      );
      toast.success(
        `Merged T${tableActionTable.number} into T${tableActionTarget.number}`,
      );
      setTableActionTable(null);
      setTableActionTarget(null);
      setTableActionMode(null);
      await loadTables();
    } catch (e: any) {
      toast.error(e?.response?.data?.message || "Merge failed");
    }
  };
  const transferTableOrders = async () => {
    if (!tableActionTable || !tableActionTarget) return;
    try {
      const orderIds = (tableActionTable.orders || [])
        .filter((o: any) => o.status === "OPEN")
        .map((o: any) => o.id);
      await api.post(`/tables/${tableActionTable.id}/transfer/${tableActionTarget.id}`, {
        orderIds,
      });
      toast.success(
        `Transferred orders to T${tableActionTarget.number}`,
      );
      setTableActionTable(null);
      setTableActionTarget(null);
      setTableActionMode(null);
      await loadTables();
    } catch (e: any) {
      toast.error(e?.response?.data?.message || "Transfer failed");
    }
  };

  const openOrderNoteEditor = () => {
    setOrderNoteText(currentOrder?.notes || "");
    setOrderNoteEdit(true);
  };
  const saveOrderNote = async () => {
    if (!currentOrder) return;
    try {
      // Backend may not expose a direct notes-only PATCH; piggyback via PUT /orders/:id/type with notes
      // fallback: re-POST addItem won't work. Try PATCH /orders/:id with notes.
      await api.put(`/orders/${currentOrder.id}/type`, {
        type: currentOrder.type,
        notes: orderNoteText,
      }).catch(async () => {
        // Fallback: hit a generic update endpoint if available
        await api.patch?.(`/orders/${currentOrder.id}`, { notes: orderNoteText });
      });
      await refreshOrder(currentOrder.id);
      toast.success("Order note saved");
      setOrderNoteEdit(false);
    } catch (e: any) {
      toast.error(e?.response?.data?.message || "Note save failed");
    }
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
      // Use the reason-aware endpoint when a reason is given.
      const trimmedReason = (discountReason || "").trim();
      const r = await api.put(
        trimmedReason
          ? `/orders/${currentOrder.id}/discount-with-reason`
          : `/orders/${currentOrder.id}/discount`,
        {
          discountType,
          discountValue,
          ...(trimmedReason ? { reason: trimmedReason } : {}),
        },
      );
      setCurrentOrder(r.data);
      setShowDiscountDialog(false);
      setDiscountReason("");
    } catch (e: any) {
      toast.error(e?.response?.data?.message || "Discount failed");
    }
  };

  const printKOT = async () => {
    if (!currentOrder) return;
    const newItems = activeItems.filter((i) => !i.kotPrinted);
    try {
      await api.post(`/orders/${currentOrder.id}/kot`);
      await refreshOrder(currentOrder.id);
      openPrintWindow(
        buildKOTHtml(
          currentOrder,
          newItems,
          selectedTable ? `T${selectedTable.number}` : "Takeaway",
        ),
      );
      toast.success(`${newItems.length} item(s) sent to kitchen`);
    } catch {
      toast.error("KOT print failed");
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
              amount: currentOrder.total,
              tendered: paymentMethod === "CASH" ? cashTendered : currentOrder.total,
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
      setShowTableDialog(true);
      await loadTables();
      toast.success(
        change > 0 ? `Change: UGX ${change.toFixed(2)}` : "Order settled",
      );
    } catch (err: any) {
      toast.error(err.response?.data?.message || "Payment failed");
    }
  };

  const handleTableSelect = async (table: any) => {
    setShowTableDialog(false);
    setSelectedTable(table);
    if (table.orders?.length) {
      await refreshOrder(table.orders[0].id);
    } else {
      setCurrentOrder(null);
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

  const typeIcons: Record<string, React.ReactNode> = {
    DINE_IN: <Building className="w-3 h-3" />,
    TAKEAWAY: <ShoppingBag className="w-3 h-3" />,
    DELIVERY: <Truck className="w-3 h-3" />,
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
      <Toaster position="top-right" richColors />

      {/* ══ TOP BAR ══ */}
      <div className="bg-[#1a7fcf] px-5 h-14 flex items-center justify-between flex-shrink-0 shadow-lg shadow-blue-500/40">
        {/* Brand */}
        <div className="flex items-center gap-2.5 font-black text-xl text-white tracking-tight">
          <div className="w-9 h-9 bg-white/20 rounded-[10px] flex items-center justify-center">
            <Store className="w-[18px] h-[18px] text-white" />
          </div>
          NeuroPOS
        </div>

        {/* Search */}
        <div className="flex items-center gap-2.5 bg-white/15 rounded-[10px] px-3.5 h-10 w-80 border border-white/25">
          <Search className="w-3.5 h-3.5 text-white/70" />
          <input
            className="border-none bg-transparent outline-none flex-1 text-sm text-white placeholder:text-white/70 font-[Nunito]"
            placeholder="Search menu items…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button
              className="border-none bg-none cursor-pointer text-white/70"
              onClick={() => setSearchQuery("")}
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>

        {/* Table picker */}
        <button
          className="flex items-center gap-2 px-[18px] py-2 rounded-[10px] border-2 border-white/30 text-white cursor-pointer text-sm font-bold transition-all font-[Nunito]"
          style={{
            background: selectedTable
              ? "rgba(255,255,255,.25)"
              : "rgba(255,255,255,.1)",
          }}
          onClick={() => {
            loadTables();
            setShowTableDialog(true);
          }}
        >
          <LayoutGrid className="w-[15px] h-[15px]" />
          {selectedTable ? `Table T${selectedTable.number}` : "Select Table"}
          {selectedTable && (
            <span className="bg-white/25 text-white rounded-md px-2 py-px text-[11px] font-extrabold">
              ACTIVE
            </span>
          )}
        </button>

        {/* Right controls */}
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] border border-white/30 text-white text-xs font-bold cursor-pointer bg-white/10"
            onClick={() => {
              loadHeldOrders();
              setShowHeldDialog(true);
            }}
            title="View held orders"
          >
            <Pause className="w-3 h-3" /> Held
          </button>
          <div className="flex bg-white/15 border border-white/20 rounded-[10px] p-[3px] gap-0.5">
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
                {typeIcons[t]}
                {typeLabels[t]}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 px-3.5 py-1.5 bg-white/15 border border-white/20 rounded-full text-[13px] font-semibold text-white">
            <User className="w-3.5 h-3.5" />
            {user?.name}
          </div>
          <button
            className="w-[38px] h-[38px] rounded-[10px] border border-white/25 bg-white/10 text-white flex items-center justify-center cursor-pointer"
            onClick={logout}
          >
            <Power className="w-[15px] h-[15px]" />
          </button>
        </div>
      </div>

      {/* ══ MAIN ══ */}
      <div className="flex flex-1 overflow-hidden min-h-0">
        {/* ── LEFT: Menus ── */}
        <div className="flex-1 flex flex-col overflow-hidden pl-[18px] pr-3.5 py-3.5 min-w-0 relative">
          {/* Category strip */}
          <div className="pos-scroll flex gap-2 overflow-x-auto pb-3 flex-shrink-0">
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
          <div className="pos-scroll flex-1 overflow-y-auto pr-1 pb-2 min-h-0">
            <div className="grid grid-cols-[repeat(auto-fill,minmax(185px,1fr))] gap-3.5 content-start">
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
                        className="w-full h-[105px] object-cover block"
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = "none";
                        }}
                      />
                    ) : null}
                    <div
                      className="w-full h-[105px] flex items-center justify-center text-[44px]"
                      style={{
                        background: `linear-gradient(135deg,${color}18,${color}35)`,
                        display: imgSrc ? "none" : "flex",
                      }}
                    >
                      {getCategoryEmoji(menu.category?.name || "")}
                    </div>
                    <div className="px-[13px] pt-2.5 pb-3 flex flex-col flex-1">
                      <div className="text-[13px] font-extrabold text-[#1e2d3d] leading-tight mb-2">
                        {menu.name}
                      </div>
                      <div className="flex items-center justify-between mt-auto">
                        <span
                          className="text-[15px] font-extrabold"
                          style={{ color }}
                        >
                          {menu.price}
                        </span>
                        {menu.addOns?.length ? (
                          <span className="text-[10px] bg-[#fef3c7] text-[#d97706] px-[7px] py-0.5 rounded-md font-bold">
                            +Addons
                          </span>
                        ) : null}
                        <div
                          className="w-7 h-7 rounded-full flex items-center justify-center"
                          style={{
                            background: color,
                            boxShadow: `0 3px 8px ${color}60`,
                          }}
                        >
                          <Plus className="w-3 h-3 text-white font-bold" />
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
              {filteredMenus.length === 0 && (
                <div className="col-span-full text-center py-12 text-[#9baab8]">
                  <div className="text-[44px] mb-2">🔍</div>
                  <p className="m-0 font-bold">No menus found</p>
                </div>
              )}
            </div>
          </div>

          {/* TABLE LOCK OVERLAY */}
          {!selectedTable && (
            <div className="absolute inset-0 bg-[rgba(238,243,248,.88)] backdrop-blur-[3px] flex flex-col items-center justify-center gap-4 z-10">
              <div className="lock-pulse w-20 h-20 rounded-3xl bg-gradient-to-br from-[#1a7fcf] to-[#1565a8] flex items-center justify-center shadow-xl shadow-blue-500/40">
                <Lock className="w-9 h-9 text-white" />
              </div>
              <div className="text-center">
                <div className="text-[22px] font-black text-[#1a7fcf] mb-1.5">
                  Select a Table First
                </div>
                <div className="text-sm text-[#6c7a8d] mb-5">
                  Choose a table to start taking orders
                </div>
                <button
                  className="pos-btn pos-btn-primary px-8 py-3 text-[15px]"
                  onClick={() => {
                    loadTables();
                    setShowTableDialog(true);
                  }}
                >
                  <LayoutGrid className="w-4 h-4" /> Browse Tables
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ── RIGHT: Order Panel ── */}
        <div className="w-[370px] bg-white border-l border-[#d0e3f0] flex flex-col flex-shrink-0">
          {/* Panel header */}
          <div className="px-4 pt-3 pb-2.5 border-b border-[#e8f3fb] bg-[#f0f7fd]">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-base font-black text-[#1a7fcf]">
                  Order Details
                </div>
                {selectedTable && (
                  <div className="text-xs text-[#6c7a8d] mt-0.5">
                    Table T{selectedTable.number} ·{" "}
                    {orderType.replace("_", " ")}
                    {currentOrder?.status === "COMPLETED" ? (
                      <span className="ml-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 text-[10px] font-extrabold">
                        COMPLETED
                      </span>
                    ) : null}
                    {currentOrder?.status === "CANCELLED" ? (
                      <span className="ml-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 text-[10px] font-extrabold">
                        CANCELLED
                      </span>
                    ) : null}
                  </div>
                )}
              </div>
              {currentOrder?.customer && (
                <div className="flex items-center gap-1.5 px-2.5 py-1 bg-[#e8f3fb] border border-[#b3cfe8] rounded-full text-xs font-bold text-[#1a7fcf]">
                  <User className="w-[11px] h-[11px]" />
                  {currentOrder.customer.name}
                </div>
              )}
            </div>
            {/* Order note (Sprint 1 / 01.6) */}
            {currentOrder && currentOrder.status === "OPEN" ? (
              <div className="mt-2 flex items-center gap-1.5">
                <StickyNote className="w-3.5 h-3.5 text-[#6c7a8d]" />
                <Input
                  className="h-7 text-xs flex-1"
                  placeholder="Add an order note (e.g. birthday customer)…"
                  value={orderNoteEdit ? orderNoteText : currentOrder.notes || ""}
                  onChange={(e) => {
                    setOrderNoteEdit(true);
                    setOrderNoteText(e.target.value);
                  }}
                  onBlur={() => {
                    if (orderNoteEdit && orderNoteText !== (currentOrder.notes || "")) {
                      saveOrderNote();
                    }
                  }}
                />
                {reprintCount > 0 ? (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 font-extrabold whitespace-nowrap">
                    Reprinted ×{reprintCount}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>

          {/* Items */}
          <div className="pos-scroll flex-1 overflow-y-auto px-2 py-1.5">
            {activeItems.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full gap-2.5 text-[#9baab8] px-8">
                <ShoppingCart className="w-11 h-11 opacity-25" />
                <p className="m-0 font-bold text-[#6c7a8d]">No items yet</p>
                <small className="text-[#9baab8]">
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
                        className="w-9 h-9 rounded-lg object-cover flex-shrink-0"
                      />
                    ) : (
                      <div className="w-9 h-9 rounded-lg bg-[#e8f3fb] flex items-center justify-center text-xl flex-shrink-0">
                        {getCategoryEmoji(item.menu?.category?.name || "")}
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-[5px]">
                        <span className="text-[13px] font-extrabold text-[#1e2d3d]">
                          {item.menu?.name}
                        </span>
                        {item.kotPrinted && (
                          <CheckCircle2
                            className="w-[11px] h-[11px] text-green-600"
                            title="KOT Sent"
                          />
                        )}
                      </div>
                      {item.addOns && (
                        <div className="flex flex-wrap gap-1 mt-[3px]">
                          {JSON.parse(item.addOns).map((a: any) => (
                            <span
                              key={a.id}
                              className="text-[10px] bg-[#fef3c7] text-[#a16207] px-1.5 py-px rounded font-bold"
                            >
                              +{a.name}
                            </span>
                          ))}
                        </div>
                      )}
                      <div className="flex items-center gap-1.5 mt-[5px]">
                        <button
                          className="w-6 h-6 rounded-md border border-[#d0e3f0] bg-white flex items-center justify-center text-[13px] text-[#1a7fcf] font-bold cursor-pointer"
                          onClick={() =>
                            updateQuantity(item.id, item.quantity - 1)
                          }
                        >
                          −
                        </button>
                        <span className="text-[13px] font-extrabold min-w-[20px] text-center text-[#1e2d3d]">
                          {item.quantity}
                        </span>
                        <button
                          className="w-6 h-6 rounded-md border border-[#d0e3f0] bg-white flex items-center justify-center text-[13px] text-[#1a7fcf] font-bold cursor-pointer"
                          onClick={() =>
                            updateQuantity(item.id, item.quantity + 1)
                          }
                        >
                          +
                        </button>
                        <button
                          className="w-6 h-6 rounded-md border border-[#d0e3f0] bg-white text-[#0ea5e9] flex items-center justify-center text-[11px] cursor-pointer"
                          onClick={() => openLineNotePrompt(item.id, item.notes)}
                          title={item.notes ? `Note: ${item.notes}` : "Add note"}
                        >
                          <StickyNote className="w-3 h-3" />
                        </button>
                        <button
                          className="w-6 h-6 rounded-md border-none bg-[#fff1f0] text-red-600 flex items-center justify-center text-[11px] ml-0.5 cursor-pointer"
                          onClick={() => voidItem(item.id)}
                          title="Void item"
                        >
                          <Ban className="w-3 h-3" />
                        </button>
                        <button
                          className="w-6 h-6 rounded-md border-none bg-[#f3f4f6] text-[#374151] flex items-center justify-center text-[11px] cursor-pointer"
                          onClick={() => removeItem(item.id)}
                          title="Remove"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                    <span className="text-[13px] font-extrabold text-[#1a7fcf] flex-shrink-0">
                      {item.totalPrice + item.addOnsTotal}
                    </span>
                  </div>
                );
              })
            )}
            {voidedItems.length > 0 && (
              <>
                <div className="text-[10px] font-extrabold text-[#9baab8] uppercase tracking-wider my-2 mx-0">
                  Voided
                </div>
                {voidedItems.map((item) => (
                  <div key={item.id} className="pos-order-item voided">
                    <span className="text-[13px] font-bold line-through text-[#9baab8] flex-1">
                      {item.menu?.name}
                    </span>
                    <span className="text-[10px] font-extrabold text-red-600 bg-[#fee2e2] px-2 py-0.5 rounded-md">
                      VOID
                    </span>
                  </div>
                ))}
              </>
            )}
          </div>

          {/* Summary */}
          <div className="px-4 py-3 border-t border-[#e8f3fb]">
            {currentOrder ? (
              <>
                <div className="flex justify-between text-[13px] text-[#6c7a8d] mb-[5px]">
                  <span>Subtotal</span>
                  <span className="font-semibold">
                    UGX {currentOrder.subtotal.toFixed(2)}
                  </span>
                </div>
                {currentOrder.discountAmount > 0 && (
                  <div className="flex justify-between text-[13px] text-green-600 mb-[5px]">
                    <span>Discount</span>
                    <span className="font-bold">
                      − UGX {currentOrder.discountAmount.toFixed(2)}
                    </span>
                  </div>
                )}
                {currentOrder.tax > 0 && (
                  <div className="flex justify-between text-[13px] text-[#6c7a8d] mb-[5px]">
                    <span>Tax</span>
                    <span>UGX {currentOrder.tax.toFixed(2)}</span>
                  </div>
                )}
                <div className="h-px bg-[#d0e3f0] my-2" />
                <div className="flex justify-between text-[17px] font-black text-[#1a7fcf]">
                  <span>Total</span>
                  <span>UGX {currentOrder.total.toFixed(2)}</span>
                </div>
              </>
            ) : (
              <div className="flex justify-between text-base font-extrabold text-[#9baab8]">
                <span>Total</span>
                <span>UGX 0.00</span>
              </div>
            )}
          </div>

          {/* Action buttons */}
          <div className="px-2.5 pt-2 pb-3 flex flex-col gap-2">
            {/* Sprint 1 secondary row: Hold / Cancel / Reprint */}
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                className="pos-action-btn"
                disabled={!currentOrder || currentOrder.status !== "OPEN"}
                style={{
                  background:
                    !currentOrder || currentOrder.status !== "OPEN"
                      ? "#e9eef4"
                      : "#fef3c7",
                  color:
                    !currentOrder || currentOrder.status !== "OPEN"
                      ? "#aab5c2"
                      : "#92400e",
                  boxShadow:
                    !currentOrder || currentOrder.status !== "OPEN"
                      ? "none"
                      : "0 4px 12px rgba(245,158,11,.25)",
                }}
                onClick={openHoldPrompt}
                title="Hold / park this order"
              >
                <Pause className="w-[17px] h-[17px]" />
                <span>Hold</span>
              </button>
              <button
                type="button"
                className="pos-action-btn"
                disabled={
                  !currentOrder ||
                  (currentOrder.status !== "OPEN" &&
                    currentOrder.status !== "HELD")
                }
                style={{
                  background:
                    !currentOrder ||
                    (currentOrder.status !== "OPEN" &&
                      currentOrder.status !== "HELD")
                      ? "#e9eef4"
                      : "#fee2e2",
                  color:
                    !currentOrder ||
                    (currentOrder.status !== "OPEN" &&
                      currentOrder.status !== "HELD")
                      ? "#aab5c2"
                      : "#991b1b",
                  boxShadow:
                    !currentOrder ||
                    (currentOrder.status !== "OPEN" &&
                      currentOrder.status !== "HELD")
                      ? "none"
                      : "0 4px 12px rgba(220,38,38,.25)",
                }}
                onClick={openCancelPrompt}
                title="Cancel this order"
              >
                <Ban className="w-[17px] h-[17px]" />
                <span>Cancel</span>
              </button>
              <button
                type="button"
                className="pos-action-btn"
                disabled={!currentOrder || currentOrder.status !== "COMPLETED"}
                style={{
                  background:
                    !currentOrder || currentOrder.status !== "COMPLETED"
                      ? "#e9eef4"
                      : "#ede9fe",
                  color:
                    !currentOrder || currentOrder.status !== "COMPLETED"
                      ? "#aab5c2"
                      : "#5b21b6",
                  boxShadow:
                    !currentOrder || currentOrder.status !== "COMPLETED"
                      ? "none"
                      : "0 4px 12px rgba(139,92,246,.25)",
                }}
                onClick={openReprintPrompt}
                title="Reprint receipt (COMPLETED orders only)"
              >
                <RotateCcw className="w-[17px] h-[17px]" />
                <span>Reprint</span>
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {ACTION_BTNS.slice(0, 3).map((btn) => {
                const disabled = !currentOrder;
                const Icon = btn.icon;
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
                    <Icon className="w-[17px] h-[17px]" />
                    <span>{btn.label}</span>
                  </button>
                );
              })}
            </div>
            <div className="grid grid-cols-3 gap-2">
              {ACTION_BTNS.slice(3, 6).map((btn) => {
                const disabled =
                  btn.key === "checkout"
                    ? !currentOrder || activeItems.length === 0
                    : !currentOrder || activeItems.length === 0;
                const Icon = btn.icon;
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
                    <Icon className="w-[17px] h-[17px]" />
                    <span>{btn.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* ══════════════════════════════════════════
          DIALOG 1 — TABLE SELECTION
      ══════════════════════════════════════════ */}
      <Dialog
        open={showTableDialog}
        onOpenChange={(open) => {
          if (!open && selectedTable) setShowTableDialog(false);
        }}
      >
        <DialogContent className="sm:max-w-[860px] p-0 overflow-hidden">
          <DialogHeader className="bg-[#1a7fcf] text-white p-4">
            <DialogTitle className="text-white text-base font-bold flex items-center gap-2">
              <LayoutGrid className="w-4 h-4" /> Table Selection
            </DialogTitle>
          </DialogHeader>
          <div className="bg-white border-b border-[#d0e3f0] px-5 py-3 flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-bold text-[#6c7a8d] uppercase tracking-wider mr-1">
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
                className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-bold cursor-pointer transition-all font-[Nunito]"
                style={{
                  border: `1.5px solid ${tableFilter === f.key ? f.color : "#d0e3f0"}`,
                  background: tableFilter === f.key ? f.color : "#fff",
                  color: tableFilter === f.key ? "#fff" : "#6c7a8d",
                }}
              >
                {f.label}
                <span
                  className="rounded-[10px] px-1.5 text-[11px] font-extrabold min-w-[18px] text-center"
                  style={{
                    background:
                      tableFilter === f.key
                        ? "rgba(255,255,255,.28)"
                        : "#e8f3fb",
                    color: tableFilter === f.key ? "#fff" : "#1a7fcf",
                  }}
                >
                  {f.count}
                </span>
              </button>
            ))}
            <button
              className="ml-auto flex items-center gap-1.5 px-3.5 py-1.5 rounded-full border border-[#d0e3f0] bg-white text-[#6c7a8d] text-xs font-bold cursor-pointer font-[Nunito]"
              onClick={loadTables}
            >
              <RefreshCw className="w-3 h-3" /> Refresh
            </button>
          </div>
          <div className="pos-scroll p-5 overflow-y-auto max-h-[calc(90vh-220px)]">
            {filteredTables.length === 0 ? (
              <div className="text-center py-12 text-[#9baab8]">
                <div className="text-[44px] mb-2">🪑</div>
                <p className="m-0 font-bold">No tables found</p>
              </div>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-3.5">
                {filteredTables.map((table) => {
                  const cfg = TBL[table.status?.toLowerCase()] || TBL.available;
                  const isSelected = selectedTable?.id === table.id;
                  return (
                    <div
                      key={table.id}
                      className="pos-table-card"
                      style={{
                        background: isSelected ? "#e8f3fb" : cfg.bg,
                        border: `2px solid ${isSelected ? "#1a7fcf" : cfg.border}`,
                        boxShadow: isSelected
                          ? "0 0 0 3px rgba(26,127,207,.2), 0 8px 24px rgba(26,127,207,.15)"
                          : "0 2px 8px rgba(0,0,0,.05)",
                      }}
                      onClick={() => handleTableSelect(table)}
                      onMouseEnter={() => setHoveredTable(table.id)}
                      onMouseLeave={() => setHoveredTable(null)}
                    >
                      {isSelected && (
                        <div className="absolute top-2 right-2 w-5 h-5 rounded-full bg-[#1a7fcf] flex items-center justify-center">
                          <Check className="w-2.5 h-2.5 text-white" />
                        </div>
                      )}
                      <div
                        className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full"
                        style={{
                          background: `${cfg.dot}18`,
                          color: cfg.dot,
                          border: `1px solid ${cfg.dot}30`, // Added back from your lower snippet
                        }}
                      >
                        <div
                          className="w-[5px] h-[5px] rounded-full"
                          style={{ background: cfg.dot }}
                        />
                        {cfg.label}
                      </div>
                      {table.zone && (
                        <div className="text-[10px] text-[#9baab8] mt-1 font-semibold">
                          {table.zone}
                        </div>
                      )}
                      {/* Sprint 1 / 01.7: quick merge / transfer actions for
                          occupied tables with open orders */}
                      {table.status?.toLowerCase() === "occupied" &&
                      (table.orders || []).some(
                        (o: any) => o.status === "OPEN",
                      ) ? (
                        <div
                          className="mt-2 flex flex-wrap gap-1"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            type="button"
                            className="text-[10px] px-1.5 py-0.5 rounded bg-pink-50 text-pink-700 hover:bg-pink-100 font-bold flex items-center gap-1"
                            onClick={() => {
                              setTableActionTable(table);
                              setTableActionMode("transfer");
                              setTableActionTarget(null);
                            }}
                            title="Transfer orders to another table"
                          >
                            <ArrowRightLeft className="w-2.5 h-2.5" /> Transfer
                          </button>
                          <button
                            type="button"
                            className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 hover:bg-indigo-100 font-bold flex items-center gap-1"
                            onClick={() => {
                              setTableActionTable(table);
                              setTableActionMode("merge");
                              setTableActionTarget(null);
                            }}
                            title="Merge this table into another"
                          >
                            <Link2 className="w-2.5 h-2.5" /> Merge
                          </button>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Legend */}
            <div className="flex gap-3.5 justify-center mt-5 pt-4 border-t border-[#d0e3f0] flex-wrap">
              {Object.entries(TBL).map(([k, cfg]) => (
                <div
                  key={k}
                  className="flex items-center gap-1.5 text-xs text-[#6c7a8d]"
                >
                  <div
                    className="w-2.5 h-2.5 rounded-full"
                    style={{ background: cfg.dot }}
                  />
                  {cfg.label}{" "}
                  <span className="font-extrabold text-[#2c3e50]">
                    (
                    {tables.filter((t) => t.status?.toLowerCase() === k).length}
                    )
                  </span>
                </div>
              ))}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ══════════════════════════════════════════
          DIALOG 2 — ADD-ONS
      ══════════════════════════════════════════ */}
      <Dialog open={showAddOnDialog} onOpenChange={setShowAddOnDialog}>
        <DialogContent className="sm:max-w-[440px] p-0 overflow-hidden">
          <DialogHeader className="bg-[#1a7fcf] text-white p-4">
            <DialogTitle className="text-white text-base font-bold flex items-center gap-2">
              <Star className="w-4 h-4" /> Add-ons — {selectedMenu?.name}
            </DialogTitle>
          </DialogHeader>
          <div className="p-5 pb-0">
            <div className="text-[13px] text-[#6c7a8d] mb-4 flex items-center gap-2">
              <Info className="w-4 h-4 text-[#1a7fcf]" />
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
                      className="w-9 h-9 rounded-[10px] flex items-center justify-center flex-shrink-0 transition-colors"
                      style={{
                        background: checked ? "#1a7fcf" : "#e8f3fb",
                      }}
                    >
                      {checked ? (
                        <Check className="w-3.5 h-3.5 text-white" />
                      ) : (
                        <Plus className="w-3.5 h-3.5 text-[#1a7fcf]" />
                      )}
                    </div>
                    <span className="flex-1 text-sm font-bold text-[#1e2d3d]">
                      {addon.name}
                    </span>
                    <span
                      className="text-[15px] font-black"
                      style={{
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
              <div className="flex justify-between items-center p-3 bg-[#e8f3fb] rounded-[10px] border border-[#b3cfe8] mt-2">
                <span className="text-[13px] text-[#6c7a8d] font-semibold">
                  {selectedAddOns.length} add-on
                  {selectedAddOns.length > 1 ? "s" : ""} selected
                </span>
                <span className="text-[15px] font-black text-[#1a7fcf]">
                  + UGX{" "}
                  {(
                    selectedMenu?.addOns
                      ?.filter((a) => selectedAddOns.includes(a.id))
                      .reduce((s, a) => s + a.price, 0) || 0
                  ).toFixed(2)}
                </span>
              </div>
            )}
          </div>
          <DialogFooter className="bg-[#f6fafd] border-t border-[#d0e3f0] p-4 gap-2">
            <Button
              variant="outline"
              className="flex-1 font-bold font-[Nunito]"
              onClick={() => {
                setShowAddOnDialog(false);
                addItemToOrder(selectedMenu!.id);
              }}
            >
              <SkipForward className="w-4 h-4 mr-1" /> Skip Add-ons
            </Button>
            <Button
              className="flex-[2] bg-[#1a7fcf] hover:bg-[#1565a8] font-bold font-[Nunito]"
              onClick={confirmAddOns}
            >
              <ShoppingCart className="w-4 h-4 mr-1" /> Add to Order
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ══════════════════════════════════════════
          DIALOG 3 — DISCOUNT
      ══════════════════════════════════════════ */}
      <Dialog open={showDiscountDialog} onOpenChange={setShowDiscountDialog}>
        <DialogContent className="sm:max-w-[420px] p-0 overflow-hidden">
          <DialogHeader className="bg-[#1a7fcf] text-white p-4">
            <DialogTitle className="text-white text-base font-bold flex items-center gap-2">
              <Percent className="w-4 h-4" /> Apply Discount
            </DialogTitle>
          </DialogHeader>
          <div className="p-5 pb-0">
            {/* Type toggle */}
            <div className="flex bg-[#e8f3fb] border border-[#b3cfe8] rounded-[10px] p-1 gap-1 mb-5">
              {[
                {
                  type: "percentage" as const,
                  icon: Percent,
                  label: "Percentage",
                },
                {
                  type: "fixed" as const,
                  icon: DollarSign,
                  label: "Fixed Amount",
                },
              ].map((opt) => (
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
                  <opt.icon className="w-3.5 h-3.5" /> {opt.label}
                </button>
              ))}
            </div>

            <div className="bg-white border border-[#d0e3f0] rounded-[10px] shadow-[0_1px_4px_rgba(26,127,207,.07)] mb-4">
              <div className="bg-[#e8f3fb] border-b border-[#d0e3f0] px-4 py-2.5 text-[13px] font-bold text-[#1565a8] uppercase tracking-wider rounded-t-[10px]">
                {discountType === "percentage"
                  ? "Discount Percentage"
                  : "Fixed Discount Amount"}
              </div>
              <div className="p-5">
                <div className="flex items-center justify-center gap-2 mb-4">
                  {discountType === "fixed" && (
                    <span className="text-[32px] font-black text-[#1a7fcf]">
                      UGX{" "}
                    </span>
                  )}
                  <Input
                    type="number"
                    value={discountValue || ""}
                    onChange={(e) => setDiscountValue(Number(e.target.value))}
                    className="w-40 text-center text-[42px] font-black text-[#1a7fcf] border-none bg-transparent p-0 h-auto focus-visible:ring-0"
                    placeholder="0"
                    min={0}
                    max={discountType === "percentage" ? 100 : undefined}
                  />
                  {discountType === "percentage" && (
                    <span className="text-[32px] font-black text-[#1a7fcf]">
                      %
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-4 gap-2">
                  {(discountType === "percentage"
                    ? [5, 10, 15, 20]
                    : [500, 1000, 2000, 5000]
                  ).map((v) => (
                    <button
                      key={v}
                      className={`py-2 rounded-lg border text-sm font-bold font-[Nunito] transition-all ${discountValue === v ? "bg-[#1a7fcf] text-white border-[#1a7fcf]" : "bg-white text-[#2c3e50] border-[#d0e3f0] hover:border-[#1a7fcf]"}`}
                      onClick={() => setDiscountValue(v)}
                    >
                      {discountType === "percentage" ? `${v}%` : `UGX ${v}`}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {discountValue > 0 && currentOrder && (
              <div className="flex items-center justify-between p-3 bg-[#f0fdf4] border border-[#86efac] rounded-[10px] mb-2">
                <span className="flex items-center gap-2 text-[13px] font-bold text-[#15803d]">
                  <CheckCircle2 className="w-4 h-4" /> Customer saves
                </span>
                <span className="text-lg font-black text-[#15803d]">
                  UGX {savingsCalc().toFixed(2)}
                </span>
              </div>
            )}

            {/* Sprint 1 / 01.6: Discount reason (required by backend when using
                discount-with-reason) */}
            <div className="mb-2">
              <label className="text-[13px] font-bold text-[#2c3e50] block mb-1.5">
                Reason <span className="text-rose-500">*</span>
              </label>
              <Textarea
                rows={2}
                value={discountReason}
                onChange={(e) => setDiscountReason(e.target.value)}
                placeholder="e.g. Happy hour, VIP, manager override"
                className="text-sm"
              />
              <p className="text-[11px] text-[#9baab8] mt-1">
                Reason is required and recorded with the discount.
              </p>
            </div>
          </div>
          <DialogFooter className="bg-[#f6fafd] border-t border-[#d0e3f0] p-4 gap-2">
            <Button
              variant="destructive"
              className="flex-1 font-bold font-[Nunito]"
              disabled={!currentOrder?.discountAmount}
              onClick={() => {
                setDiscountValue(0);
                setDiscountReason("");
                applyDiscount();
              }}
            >
              <Trash2 className="w-4 h-4 mr-1" /> Remove
            </Button>
            <Button
              className="flex-[2] bg-[#1a7fcf] hover:bg-[#1565a8] font-bold font-[Nunito]"
              disabled={discountValue === 0}
              onClick={() => {
                if (discountValue > 0) applyDiscount();
              }}
            >
              <Check className="w-4 h-4 mr-1" /> Apply Discount
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reason field appended to discount dialog (Sprint 1 / 01.6) */}
      {/* Render the reason field inline above the footer by adding a wrapper:
          we re-open the dialog body via a duplicate Dialog below just for the reason.
          Simpler: add it as a Textarea inside the discount dialog above the footer. */}

      {/* ══════════════════════════════════════════
          DIALOG 4 — CUSTOMER
      ══════════════════════════════════════════ */}
      <Dialog open={showCustomerDialog} onOpenChange={setShowCustomerDialog}>
        <DialogContent className="sm:max-w-[520px] p-0 overflow-hidden">
          <DialogHeader className="bg-[#1a7fcf] text-white p-4">
            <DialogTitle className="text-white text-base font-bold flex items-center gap-2">
              <Users className="w-4 h-4" /> Select Customer
            </DialogTitle>
          </DialogHeader>
          <div className="p-5 pb-0">
            <div className="pos-input-icon mb-3.5">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9baab8] w-3.5 h-3.5" />
              <Input
                className="pos-input pl-9"
                value={customerSearch}
                onChange={(e) => setCustomerSearch(e.target.value)}
                placeholder="Search by name or phone…"
                onKeyUp={loadCustomers}
              />
            </div>

            <div className="bg-white border border-[#d0e3f0] rounded-[10px] shadow-[0_1px_4px_rgba(26,127,207,.07)] mb-4">
              <div className="bg-[#e8f3fb] border-b border-[#d0e3f0] px-4 py-2.5 text-[13px] font-bold text-[#1565a8] uppercase tracking-wider rounded-t-[10px]">
                Existing Customers
              </div>
              <div className="pos-scroll max-h-[220px] overflow-y-auto p-3">
                {customers.length === 0 ? (
                  <div className="text-center py-6 text-[#9baab8]">
                    <Search className="w-8 h-8 mx-auto mb-2 opacity-50" />
                    <div className="text-[13px] font-semibold">
                      No customers found
                    </div>
                    <div className="text-xs mt-1">
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
                      <div className="w-[42px] h-[42px] rounded-xl bg-[#1a7fcf] flex items-center justify-center flex-shrink-0">
                        <User className="w-[18px] h-[18px] text-white" />
                      </div>
                      <div className="flex-1">
                        <div className="text-sm font-extrabold text-[#1e2d3d]">
                          {c.name}
                        </div>
                        {c.phone && (
                          <div className="text-xs text-[#6c7a8d] mt-0.5 flex items-center gap-1">
                            <Phone className="w-3 h-3" />
                            {c.phone}
                          </div>
                        )}
                      </div>
                      <ChevronRight className="w-4 h-4 text-[#9baab8]" />
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="bg-white border border-[#d0e3f0] rounded-[10px] shadow-[0_1px_4px_rgba(26,127,207,.07)] mb-1">
              <div className="bg-[#e8f3fb] border-b border-[#d0e3f0] px-4 py-2.5 text-[13px] font-bold text-[#1565a8] uppercase tracking-wider rounded-t-[10px]">
                Add New Customer
              </div>
              <div className="p-4 flex flex-col gap-2.5">
                <div className="pos-input-icon">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9baab8] w-3.5 h-3.5" />
                  <Input
                    className="pos-input pl-9"
                    value={newCustomerName}
                    onChange={(e) => setNewCustomerName(e.target.value)}
                    placeholder="Full name *"
                  />
                </div>
                <div className="pos-input-icon">
                  <Phone className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9baab8] w-3.5 h-3.5" />
                  <Input
                    className="pos-input pl-9"
                    value={newCustomerPhone}
                    onChange={(e) => setNewCustomerPhone(e.target.value)}
                    placeholder="Phone number"
                  />
                </div>
              </div>
            </div>
          </div>
          <DialogFooter className="bg-[#f6fafd] border-t border-[#d0e3f0] p-4 gap-2">
            {currentOrder?.customer && (
              <Button
                variant="destructive"
                className="font-bold font-[Nunito]"
                onClick={() => selectCustomer(null)}
              >
                <UserMinus className="w-4 h-4 mr-1" /> Remove
              </Button>
            )}
            <Button
              variant="outline"
              className="font-bold font-[Nunito]"
              onClick={() => setShowCustomerDialog(false)}
            >
              <X className="w-4 h-4 mr-1" /> Cancel
            </Button>
            <Button
              className="bg-[#1a7fcf] hover:bg-[#1565a8] font-bold font-[Nunito]"
              disabled={!newCustomerName.trim()}
              onClick={createCustomer}
            >
              <UserPlus className="w-4 h-4 mr-1" /> Create & Select
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ══════════════════════════════════════════
          DIALOG — PAYMENT
      ══════════════════════════════════════════ */}
      <Dialog open={showPaymentDialog} onOpenChange={setShowPaymentDialog}>
        <DialogContent className="sm:max-w-[480px] p-0 overflow-hidden">
          <DialogHeader className="bg-[#1a7fcf] text-white p-4">
            <DialogTitle className="text-white text-base font-bold flex items-center gap-2">
              <Wallet className="w-4 h-4" /> Checkout
            </DialogTitle>
          </DialogHeader>
          <div className="p-5">
            {/* Total */}
            <div className="text-center p-4 bg-gradient-to-br from-[#1a7fcf] to-[#1565a8] rounded-xl mb-4">
              <div className="text-xs text-white/70 mb-1 font-bold uppercase tracking-wider">
                Total Due
              </div>
              <div className="text-[38px] font-black text-white">
                UGX {currentOrder?.total.toFixed(2)}
              </div>
            </div>

            {/* Split toggle */}
            <div className="flex items-center gap-2.5 p-3 bg-[#f0f7fd] border border-[#b3cfe8] rounded-[10px] mb-4">
              <Checkbox
                id="split-mode"
                checked={splitMode}
                onCheckedChange={(checked) => setSplitMode(checked === true)}
              />
              <label
                htmlFor="split-mode"
                className="cursor-pointer font-bold text-sm text-[#2c3e50]"
              >
                Split Payment
              </label>
            </div>

            {/* Payment method */}
            <div className="flex gap-2.5 mb-4">
              {[
                {
                  val: "CASH" as const,
                  icon: Banknote,
                  label: "Cash",
                },
                {
                  val: "MOBILE_MONEY" as const,
                  icon: Smartphone,
                  label: "Mobile Money",
                },
              ].map((m) => (
                <div
                  key={m.val}
                  className="flex-1 flex items-center gap-2.5 p-3 rounded-[10px] cursor-pointer border-2 transition-all"
                  style={{
                    borderColor:
                      paymentMethod === m.val ? "#1a7fcf" : "#d0e3f0",
                    background: paymentMethod === m.val ? "#e8f3fb" : "#f9fafb",
                  }}
                  onClick={() => setPaymentMethod(m.val)}
                >
                  <div
                    className="w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0"
                    style={{
                      borderColor:
                        paymentMethod === m.val ? "#1a7fcf" : "#d0e3f0",
                    }}
                  >
                    {paymentMethod === m.val && (
                      <div className="w-2 h-2 rounded-full bg-[#1a7fcf]" />
                    )}
                  </div>
                  <m.icon
                    className="w-4 h-4 flex-shrink-0"
                    style={{
                      color: paymentMethod === m.val ? "#1a7fcf" : "#6c7a8d",
                    }}
                  />
                  <span
                    className="font-bold text-sm"
                    style={{
                      color: paymentMethod === m.val ? "#1a7fcf" : "#2c3e50",
                    }}
                  >
                    {m.label}
                  </span>
                </div>
              ))}
            </div>

            {/* Inputs */}
            {!splitMode ? (
              paymentMethod === "CASH" ? (
                <>
                  <div className="mb-3">
                    <label className="text-[13px] font-bold text-[#2c3e50] block mb-1.5">
                      Cash Tendered
                    </label>
                    <Input
                      type="number"
                      value={cashTendered || ""}
                      onChange={(e) => setCashTendered(Number(e.target.value))}
                      className="pos-input"
                      placeholder="0.00"
                    />
                  </div>
                  {cashTendered > 0 && currentOrder && (
                    <div
                      className="flex justify-between p-2.5 rounded-[10px] mb-3 border"
                      style={{
                        background:
                          cashTendered >= currentOrder.total
                            ? "#f0fdf4"
                            : "#fff1f0",
                        borderColor:
                          cashTendered >= currentOrder.total
                            ? "#86efac"
                            : "#fecaca",
                      }}
                    >
                      <span className="font-bold text-sm">Change</span>
                      <span
                        className="font-black text-base"
                        style={{
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
                  <div className="flex flex-wrap gap-2 mb-3">
                    {[10, 20, 50, 100].map((amt) => (
                      <button
                        key={amt}
                        className="flex-1 min-w-[60px] py-2 rounded-lg border border-[#d0e3f0] bg-white text-[#2c3e50] cursor-pointer font-bold text-sm font-[Nunito] hover:border-[#1a7fcf]"
                        onClick={() => setCashTendered(amt)}
                      >
                        UGX {amt}
                      </button>
                    ))}
                    {currentOrder && (
                      <button
                        className="flex-1 min-w-[60px] py-2 rounded-lg border-2 border-[#1a7fcf] bg-[#e8f3fb] text-[#1a7fcf] cursor-pointer font-extrabold text-sm font-[Nunito]"
                        onClick={() => setCashTendered(currentOrder.total)}
                      >
                        Exact
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <div className="mb-3">
                  <label className="text-[13px] font-bold text-[#2c3e50] block mb-1.5">
                    Transaction Reference
                  </label>
                  <Input
                    value={mobileRef}
                    onChange={(e) => setMobileRef(e.target.value)}
                    className="pos-input"
                    placeholder="Enter reference number"
                  />
                </div>
              )
            ) : (
              <div className="flex flex-col gap-2 mb-3">
                <div className="flex gap-2">
                  <Input
                    type="number"
                    value={splitAmount || ""}
                    onChange={(e) => setSplitAmount(Number(e.target.value))}
                    className="pos-input flex-1"
                    placeholder="Amount"
                  />
                  {paymentMethod === "MOBILE_MONEY" && (
                    <Input
                      value={mobileRef}
                      onChange={(e) => setMobileRef(e.target.value)}
                      className="pos-input flex-1"
                      placeholder="Ref"
                    />
                  )}
                  <Button
                    className="bg-[#1a7fcf] hover:bg-[#1565a8] px-3"
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
                  >
                    <Plus className="w-4 h-4" />
                  </Button>
                </div>
                {splitPayments.map((sp, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2.5 p-2 bg-[#f0f7fd] border border-[#b3cfe8] rounded-lg"
                  >
                    <span className="text-sm">
                      {sp.method === "CASH" ? "💵" : "📱"} {sp.method}
                    </span>
                    <span className="ml-auto font-extrabold text-sm">
                      UGX {sp.amount.toFixed(2)}
                    </span>
                    <button
                      className="w-6 h-6 rounded-md border-none bg-[#f3f4f6] text-[#374151] cursor-pointer flex items-center justify-center"
                      onClick={() =>
                        setSplitPayments(
                          splitPayments.filter((_, j) => j !== i),
                        )
                      }
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
                <div className="flex justify-between text-[13px] text-[#6c7a8d] font-semibold">
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

            <Button
              className="w-full bg-[#28a745] hover:bg-[#218838] text-white font-bold text-base py-3 h-auto rounded-xl"
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
              <Check className="w-4 h-4 mr-1" /> Complete Payment
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ══════════════════════════════════════════
          DIALOG — OPEN CASH
      ══════════════════════════════════════════ */}
      <Dialog
        open={showOpenCashDialog}
        onOpenChange={(open) => hasOpenShift && setShowOpenCashDialog(open)}
      >
        <DialogContent className="sm:max-w-[380px] p-0 overflow-hidden">
          <DialogHeader className="bg-[#1a7fcf] text-white p-4">
            <DialogTitle className="text-white text-base font-bold flex items-center gap-2">
              <LockOpen className="w-4 h-4" /> Open Cash Register
            </DialogTitle>
          </DialogHeader>
          <div className="p-6 flex flex-col gap-4">
            <p className="text-[#6c7a8d] text-sm m-0">
              Enter the opening cash amount for your shift:
            </p>
            <Input
              type="number"
              value={openingAmount || ""}
              onChange={(e) => setOpeningAmount(Number(e.target.value))}
              className="pos-input"
              placeholder="0.00"
            />
            <Button
              className="w-full bg-[#1a7fcf] hover:bg-[#1565a8] font-bold"
              onClick={handleOpenCash}
            >
              <LockOpen className="w-4 h-4 mr-1" /> Open Shift
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ══════════════════════════════════════════
          DIALOG — BILL / RECEIPT
      ══════════════════════════════════════════ */}
      <Dialog open={showBillDialog} onOpenChange={setShowBillDialog}>
        <DialogContent className="sm:max-w-[460px] p-0 overflow-hidden">
          <DialogHeader className="bg-[#1a7fcf] text-white p-4">
            <DialogTitle className="text-white text-base font-bold flex items-center gap-2">
              <FileText className="w-4 h-4" /> Receipt Preview
            </DialogTitle>
          </DialogHeader>
          {currentOrder && (
            <div className="p-6 pb-7 font-mono text-sm text-[#1e2d3d]">
              <div className="text-center mb-6">
                <div className="text-[22px] font-black text-[#1a7fcf] font-[Nunito]">
                  Ruta Pub
                </div>
                <div className="text-xs text-[#6c7a8d] mt-1">
                  #{currentOrder.orderNumber} ·{" "}
                  {new Date().toLocaleString("en-US", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </div>
                {currentOrder.table && (
                  <div className="text-[13px] mt-1.5">
                    Table T{currentOrder.table.number}
                  </div>
                )}
                {currentOrder.customer && (
                  <div className="text-[13px] mt-0.5">
                    Guest: {currentOrder.customer.name}
                  </div>
                )}
              </div>
              <div className="border-t-2 border-b-2 border-dashed border-[#d0e3f0] py-4 mb-4">
                {activeItems.map((item) => (
                  <div key={item.id} className="flex justify-between mb-2.5">
                    <div className="flex-1">
                      <div>
                        {item.quantity} × {item.menu?.name}
                      </div>
                      {item.addOns && JSON.parse(item.addOns).length > 0 && (
                        <div className="text-xs text-[#6c7a8d] mt-1">
                          +{" "}
                          {JSON.parse(item.addOns)
                            .map((a: any) => a.name)
                            .join(", ")}
                        </div>
                      )}
                    </div>
                    <div className="font-bold min-w-[80px] text-right">
                      UGX {(item.totalPrice + item.addOnsTotal).toFixed(2)}
                    </div>
                  </div>
                ))}
              </div>
              <div className="mb-4">
                <div className="flex justify-between mb-2">
                  <span>Subtotal</span>
                  <span>UGX {currentOrder.subtotal.toFixed(2)}</span>
                </div>
                {currentOrder.discountAmount > 0 && (
                  <div className="flex justify-between mb-2 text-[#16a34a] font-bold">
                    <span>Discount</span>
                    <span>− UGX {currentOrder.discountAmount.toFixed(2)}</span>
                  </div>
                )}
                {currentOrder.tax > 0 && (
                  <div className="flex justify-between mb-2">
                    <span>Tax</span>
                    <span>UGX {currentOrder.tax.toFixed(2)}</span>
                  </div>
                )}
                <div className="flex justify-between text-lg font-black mt-3 pt-3 border-t-2 border-[#d0e3f0] font-[Nunito]">
                  <span>TOTAL</span>
                  <span className="text-[#1a7fcf]">
                    UGX {currentOrder.total.toFixed(2)}
                  </span>
                </div>
              </div>
              <div className="text-center text-[#6c7a8d] text-[13px] mb-6">
                Thank you for dining with us! 🍽️
                <br />
                Come back soon!
              </div>
              <Button
                className="w-full bg-[#1a7fcf] hover:bg-[#1565a8] font-bold text-[15px] py-3 h-auto rounded-xl"
                onClick={() => window.print()}
              >
                <Printer className="w-4 h-4 mr-1" /> Print Receipt
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ══════════════════════════════════════════
          ALERT — VOID CONFIRM
      ══════════════════════════════════════════ */}
      <AlertDialog
        open={!!showVoidConfirm}
        onOpenChange={() => setShowVoidConfirm(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Ban className="w-5 h-5 text-red-600" /> Void Item
            </AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to void this item? This action cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setShowVoidConfirm(null)}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={handleVoidConfirm}
            >
              Void
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ══════════════════════════════════════════
          ALERT — REMOVE CONFIRM
      ══════════════════════════════════════════ */}
      <AlertDialog
        open={!!showRemoveConfirm}
        onOpenChange={() => setShowRemoveConfirm(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Trash2 className="w-5 h-5 text-red-600" /> Remove Item
            </AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove this item from the order?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setShowRemoveConfirm(null)}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={handleRemoveConfirm}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ══════════════════════════════════════════
          SPRINT 1 — REASON PROMPT (void / cancel / hold / reprint / lineNote)
      ══════════════════════════════════════════ */}
      <Dialog
        open={!!reasonPrompt}
        onOpenChange={(o) => {
          if (!o) {
            setReasonPrompt(null);
            setReasonText("");
            setShowVoidConfirm(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-[460px]">
          <DialogHeader>
            <DialogTitle>{reasonPrompt?.title || "Confirm"}</DialogTitle>
            <DialogDescription>
              {reasonPrompt?.description || ""}
            </DialogDescription>
          </DialogHeader>
          {reasonPrompt?.multiline ? (
            <Textarea
              value={reasonText}
              onChange={(e) => setReasonText(e.target.value)}
              rows={3}
              autoFocus
              placeholder={reasonPrompt?.placeholder}
            />
          ) : (
            <Input
              value={reasonText}
              onChange={(e) => setReasonText(e.target.value)}
              autoFocus
              placeholder={reasonPrompt?.placeholder}
            />
          )}
          {reasonPrompt && (reasonPrompt.minChars ?? 0) > 0 ? (
            <p className="text-[11px] text-[#9baab8]">
              Minimum {reasonPrompt.minChars} characters.
            </p>
          ) : null}
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setReasonPrompt(null);
                setReasonText("");
                setShowVoidConfirm(null);
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                const k = reasonPrompt?.kind;
                if (k === "void") handleVoidConfirm();
                else if (k === "cancel") submitCancel();
                else if (k === "hold") submitHold();
                else if (k === "reprint") submitReprint();
                else if (k === "lineNote") submitLineNote();
              }}
              disabled={
                (reasonPrompt?.minChars ?? 0) > 0 &&
                reasonText.trim().length < (reasonPrompt?.minChars ?? 0)
              }
              style={{ background: reasonPrompt?.confirmColor || "#1a7fcf" }}
            >
              {reasonPrompt?.confirmLabel || "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ══════════════════════════════════════════
          SPRINT 1 — HELD ORDERS DIALOG
      ══════════════════════════════════════════ */}
      <Dialog
        open={showHeldDialog}
        onOpenChange={(o) => setShowHeldDialog(o)}
      >
        <DialogContent className="sm:max-w-[640px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pause className="w-4 h-4 text-amber-500" /> Held / parked orders
            </DialogTitle>
            <DialogDescription>
              Resume a parked ticket. The original table is re-occupied.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto">
            {heldOrders.length === 0 ? (
              <div className="text-center py-10 text-slate-400">
                <Pause className="w-8 h-8 mx-auto mb-2 opacity-50" />
                <p className="font-semibold">No held orders</p>
                <p className="text-xs mt-1">
                  Held tickets appear here so any cashier can resume them.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {heldOrders.map((o) => {
                  const itemCount = (o.items || []).filter(
                    (i: any) => !i.voided,
                  ).length;
                  const heldAgo = o.heldAt ? new Date(o.heldAt) : null;
                  const mins = heldAgo
                    ? Math.floor((Date.now() - heldAgo.getTime()) / 60000)
                    : 0;
                  return (
                    <div
                      key={o.id}
                      className="flex items-center gap-3 p-3 rounded-lg border border-slate-200 bg-white"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="font-bold text-sm">
                          {o.orderNumber}
                          {o.table ? (
                            <span className="text-xs text-slate-500 ml-2">
                              · T{(o.table as any).number}
                            </span>
                          ) : null}
                        </div>
                        <div className="text-xs text-slate-500 mt-0.5">
                          {itemCount} item{itemCount !== 1 ? "s" : ""} · UGX{" "}
                          {Number(o.total || 0).toLocaleString()} · {mins}m
                          ago
                        </div>
                        {o.holdReason ? (
                          <div className="text-xs italic text-slate-600 mt-0.5">
                            "{o.holdReason}"
                          </div>
                        ) : null}
                      </div>
                      <Button
                        onClick={() => resumeHeld(o.id)}
                        style={{ background: "#16a34a" }}
                      >
                        <Play className="w-4 h-4 mr-1" /> Resume
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={loadHeldOrders}
              type="button"
            >
              <RefreshCw className="w-3 h-3 mr-1" /> Refresh
            </Button>
            <Button
              variant="ghost"
              onClick={() => setShowHeldDialog(false)}
              type="button"
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ══════════════════════════════════════════
          SPRINT 1 — MERGE / TRANSFER TARGET PICKER
      ══════════════════════════════════════════ */}
      <Dialog
        open={!!tableActionTable && !!tableActionMode}
        onOpenChange={(o) => {
          if (!o) {
            setTableActionTable(null);
            setTableActionTarget(null);
            setTableActionMode(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {tableActionMode === "merge" ? (
                <>
                  <Link2 className="w-4 h-4 text-indigo-600" />
                  Merge T{tableActionTable?.number} into…
                </>
              ) : (
                <>
                  <ArrowRightLeft className="w-4 h-4 text-pink-600" />
                  Transfer T{tableActionTable?.number} orders to…
                </>
              )}
            </DialogTitle>
            <DialogDescription>
              {tableActionMode === "merge"
                ? "Source table becomes part of the target group."
                : "All open orders will move to the target table."}
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-4 gap-2 max-h-[280px] overflow-y-auto p-1">
            {tables
              .filter(
                (t) =>
                  t.id !== tableActionTable?.id &&
                  !t.mergedInto &&
                  (tableActionMode === "merge"
                    ? t.status !== "OCCUPIED"
                    : t.status === "AVAILABLE"),
              )
              .map((t) => (
                <Button
                  key={t.id}
                  type="button"
                  variant={tableActionTarget?.id === t.id ? "default" : "outline"}
                  onClick={() => setTableActionTarget(t)}
                >
                  T{t.number}
                </Button>
              ))}
            {tables.filter(
              (t) =>
                t.id !== tableActionTable?.id &&
                !t.mergedInto &&
                (tableActionMode === "merge"
                  ? t.status !== "OCCUPIED"
                  : t.status === "AVAILABLE"),
            ).length === 0 ? (
              <p className="col-span-4 text-center text-xs text-slate-400 py-4">
                No eligible target tables.
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setTableActionTable(null);
                setTableActionTarget(null);
                setTableActionMode(null);
              }}
              type="button"
            >
              Cancel
            </Button>
            <Button
              onClick={
                tableActionMode === "merge" ? mergeTables : transferTableOrders
              }
              disabled={!tableActionTarget}
              type="button"
              style={{
                background:
                  tableActionMode === "merge" ? "#4f46e5" : "#ec4899",
              }}
            >
              {tableActionMode === "merge" ? "Merge" : "Transfer"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default POSPage;
