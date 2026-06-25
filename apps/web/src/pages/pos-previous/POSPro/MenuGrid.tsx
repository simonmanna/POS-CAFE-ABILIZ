import React, { useState } from 'react';
import { Plus, ImageOff } from 'lucide-react';
import { getFoodEmoji, getCategoryColor } from './food-images';
import type { Menu } from './types';

interface Props {
  menus: Menu[];
  locked: boolean;
  onPick: (menu: Menu) => void;
}

const fmt = (n: number) => `UGX ${Number(n || 0).toLocaleString()}`;

export const MenuGrid: React.FC<Props> = ({ menus, locked, onPick }) => {
  const [broken, setBroken] = useState<Set<number>>(new Set());
  if (menus.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-slate-400 gap-2 py-16">
        <div className="text-5xl">🔍</div>
        <p className="font-semibold">No menu items</p>
        <p className="text-sm">Try a different category or clear the search.</p>
      </div>
    );
  }
  return (
    <div className="pos-menus-grid-pro">
      {menus.map((m) => {
        const color = m.category?.color || getCategoryColor(m.category?.name);
        const imgSrc = m.imageUrl || m.image;
        const emoji = getFoodEmoji(m.name, m.category?.name);
        const hasAddOns = m.addOns && m.addOns.length > 0;
        return (
          <button
            key={m.id}
            type="button"
            className={'pos-menu-card-pro text-left' + (locked ? ' locked' : '')}
            onClick={() => !locked && onPick(m)}
            title={locked ? 'Select a table first' : m.name}
            style={{ '--c': color } as React.CSSProperties}
          >
            {imgSrc && !broken.has(m.id) ? (
              <img
                src={imgSrc}
                alt={m.name}
                className="pos-menu-img"
                onError={() => setBroken((s) => new Set(s).add(m.id))}
              />
            ) : (
              <div
                className="pos-menu-emoji"
                style={{ background: `linear-gradient(135deg, ${color}1f, ${color}40)` }}
              >
                <span style={{ filter: 'drop-shadow(0 2px 4px rgba(0,0,0,.1))' }}>{emoji}</span>
              </div>
            )}
            <div className="pos-menu-body">
              <div className="pos-menu-name">{m.name}</div>
              <div className="pos-menu-meta">
                <span className="pos-menu-price" style={{ color }}>{fmt(m.price)}</span>
                {hasAddOns ? <span className="pos-menu-addon-tag">+ Add-ons</span> : null}
              </div>
            </div>
            {!locked && (
              <span className="pos-menu-add" style={{ background: color }}>
                <Plus className="h-4 w-4" />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
};
