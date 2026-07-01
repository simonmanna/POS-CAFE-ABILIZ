import React from 'react';
import { ChefHat } from 'lucide-react';
import type { Category } from './types';

interface Props {
  categories: Category[];
  activeId: number | null;
  onSelect: (id: number | null) => void;
}

export const CategoryStrip: React.FC<Props> = ({ categories, activeId, onSelect }) => {
  return (
    <div className="pos-cats-pro">
      <button
        type="button"
        className={'pos-cat-pill-pro' + (activeId === null ? ' active' : '')}
        onClick={() => onSelect(null)}
      >
        <ChefHat className="pos-cat-emoji h-4 w-4" />
        All menu
      </button>
      {categories.map((c) => (
        <button
          key={c.id}
          type="button"
          className={'pos-cat-pill-pro' + (activeId === c.id ? ' active' : '')}
          onClick={() => onSelect(c.id)}
          style={activeId === c.id ? { background: c.color || '#1a7fcf', borderColor: c.color || '#1a7fcf' } : {}}
        >
          {c.icon ? <span className="pos-cat-emoji">{c.icon}</span> : null}
          {c.name}
        </button>
      ))}
    </div>
  );
};
