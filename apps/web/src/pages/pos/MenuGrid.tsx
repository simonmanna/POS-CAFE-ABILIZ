// Menu grid — professional, photo-card style layout with gradient tiles,
// clear pricing, and one-tap "Add item" action. Column count is set
// explicitly in pos-pro.css (2 → 3 → 4 → 5 as the pane widens) so you
// reliably get 4–5 cards per row instead of leaving it to auto-fill.
import React from 'react';
import { getFoodEmoji } from './food-images';
import type { Product } from './types';

interface Props {
  products: Product[];
  locked: boolean;
  onPick: (p: Product) => void;
}

const fmt = (n: number | string | null) => `UGX ${Number(n || 0).toLocaleString()}`;

const TILE_GRADIENTS = [
  'linear-gradient(135deg, #FDE9C8 0%, #FBCB8B 100%)',
  'linear-gradient(135deg, #CFE8FF 0%, #A9D2FA 100%)',
  'linear-gradient(135deg, #D9F2E1 0%, #A9E2C0 100%)',
  'linear-gradient(135deg, #FCE1EC 0%, #F7B8D3 100%)',
  'linear-gradient(135deg, #FBDADA 0%, #F5AEAE 100%)',
  'linear-gradient(135deg, #E7E0FB 0%, #CBB9F5 100%)',
  'linear-gradient(135deg, #D3F4F5 0%, #A0E4E8 100%)',
  'linear-gradient(135deg, #FFF3C4 0%, #FCE187 100%)',
];

function tileFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return TILE_GRADIENTS[Math.abs(h) % TILE_GRADIENTS.length];
}

export const MenuGrid: React.FC<Props> = ({ products, locked, onPick }) => {
  if (products.length === 0) {
    return (
      <div className="pos-menu-empty-pro">
        <div className="pos-menu-empty-icon">🔍</div>
        <p className="pos-menu-empty-title">No items found</p>
        <p className="pos-menu-empty-sub">Try a different category or clear the search.</p>
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
            className={'pos-menu-card-pro' + (locked ? ' locked' : '')}
            onClick={() => !locked && onPick(p)}
            title={locked ? 'Open your shift first' : `${p.name} — ${fmt(price)}`}
            style={{ textDecoration: 'none', color: 'inherit' }}
          >
            <div className="pos-menu-media-pro" style={{ background: tileFor(String(p.id ?? p.name)) }}>
              {p.image ? (
                <img
                  src={p.image}
                  alt={p.name}
                  className="pos-menu-photo-pro"
                  loading="lazy"
                  // If the signed URL fails, fall back to the emoji tile.
                  onError={(e) => {
                    const img = e.currentTarget as HTMLImageElement;
                    img.style.display = 'none';
                    const fallback = img.nextElementSibling as HTMLElement | null;
                    if (fallback) fallback.style.display = '';
                  }}
                />
              ) : null}
              <span className="pos-menu-emoji-pro" style={{ display: p.image ? 'none' : undefined }}>{emoji}</span>
            </div>
            <div className="pos-menu-info-pro">
              <div className="pos-menu-text">
                <div className="pos-menu-name-pro">{p.name}</div>
                <div className="pos-menu-price-pro">{fmt(price)}</div>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
};