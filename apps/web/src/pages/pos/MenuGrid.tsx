// Menu grid — colorful cards with emoji fallbacks + click-to-add.
import React from 'react';
import { Plus } from 'lucide-react';
import { getFoodEmoji } from './food-images';
import type { Product } from './types';

interface Props {
  products: Product[];
  locked: boolean;
  onPick: (p: Product) => void;
}

const fmt = (n: number | string | null) => `UGX ${Number(n || 0).toLocaleString()}`;

export const MenuGrid: React.FC<Props> = ({ products, locked, onPick }) => {
  if (products.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-slate-400 gap-2 py-16">
        <div className="text-5xl">🔍</div>
        <p className="font-semibold">No products</p>
        <p className="text-sm">Try a different category or clear the search.</p>
      </div>
    );
  }
  return (
    <div className="pos-menus-grid-pro">
      {products.map((p) => {
        const emoji = getFoodEmoji(p.name, p.category?.name);
        const price = Number(p.salesPrice || 0);
        return (
          <button
            key={p.id}
            type="button"
            className={'pos-menu-card-pro text-left' + (locked ? ' locked' : '')}
            onClick={() => !locked && onPick(p)}
            title={locked ? 'Open your shift first' : `${p.name} — ${fmt(price)}`}
          >
            <div
              className="pos-menu-emoji"
              style={{ background: '#f1f5f9' }}
            >
              <span>{emoji}</span>
            </div>
            <div className="pos-menu-body">
              <div className="pos-menu-name">{p.name}</div>
              <div className="pos-menu-meta">
                <span className="pos-menu-price">{fmt(price)}</span>
              </div>
            </div>
            {!locked && (
              <span className="pos-menu-add" style={{ background: '#3b82f6' }}>
                <Plus className="h-4 w-4" />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
};