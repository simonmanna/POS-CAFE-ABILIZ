import React from 'react';
import { UtensilsCrossed, ShoppingBag, Truck, ChefHat } from 'lucide-react';

export type OrderType = 'dine-in' | 'takeaway' | 'delivery';

interface Props {
  onSelect: (type: OrderType) => void;
}

const OPTIONS: Array<{ type: OrderType; icon: React.ReactNode; label: string; desc: string }> = [
  { type: 'dine-in', icon: <UtensilsCrossed className="w-8 h-8" />, label: 'Dine In', desc: 'Serve at a table' },
  { type: 'takeaway', icon: <ShoppingBag className="w-8 h-8" />, label: 'Takeaway', desc: 'Pack to go' },
  { type: 'delivery', icon: <Truck className="w-8 h-8" />, label: 'Delivery', desc: 'Send with rider' },
];

export const OrderTypeSelector: React.FC<Props> = ({ onSelect }) => {
  return (
    <div className="pos-lock-overlay-pro">
      <div className="max-w-lg w-full mx-auto px-4 text-center">
        <div className="mb-8">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-gradient-to-br from-amber-400 to-orange-500 shadow-lg mb-5">
            <ChefHat className="w-10 h-10 text-white" />
          </div>
          <h1 className="text-3xl font-bold text-slate-800 mb-2">New Order</h1>
          <p className="text-slate-500 text-sm">Select the type of order to get started</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {OPTIONS.map((opt) => (
            <button
              key={opt.type}
              type="button"
              onClick={() => onSelect(opt.type)}
              className="group relative bg-white rounded-2xl border-2 border-slate-100 p-6 
                         hover:border-amber-400 hover:shadow-lg hover:-translate-y-0.5 
                         transition-all duration-200 text-center"
            >
              <div className="inline-flex items-center justify-center w-14 h-14 rounded-xl 
                              bg-amber-50 text-amber-600 group-hover:bg-amber-100 
                              transition-colors mb-4">
                {opt.icon}
              </div>
              <div className="font-bold text-lg text-slate-800 mb-1">{opt.label}</div>
              <div className="text-sm text-slate-500">{opt.desc}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

export default OrderTypeSelector;
