'use client';

import { CATEGORY_TABS, type CategoryFilter } from '@/lib/menu/catalog';

/** Pestañas de categoría. Scroll horizontal solo dentro de la barra. */
export function CategoryTabs({
  active,
  onChange,
}: {
  active: CategoryFilter;
  onChange: (category: CategoryFilter) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Categorías del menú"
      className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {CATEGORY_TABS.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(tab.id)}
            className={`shrink-0 rounded-full px-4 py-2.5 text-sm font-semibold transition-colors ${
              selected
                ? 'bg-lafija-green-dark text-white shadow-sm shadow-lafija-green-dark/30 ring-1 ring-lafija-green-dark'
                : 'bg-white text-zinc-600 ring-1 ring-zinc-200 hover:bg-zinc-50'
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
