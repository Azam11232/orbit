import { useEffect, useState } from 'react';

export type WatchlistKind = 'asset' | 'protocol';

export interface WatchlistItem {
  id: string;
  kind: WatchlistKind;
}

const STORAGE_KEY = 'orbit-watchlist-v1';

function readWatchlist(): WatchlistItem[] {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return [];
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is WatchlistItem =>
      typeof item === 'object' && item !== null &&
      typeof (item as WatchlistItem).id === 'string' &&
      ((item as WatchlistItem).kind === 'asset' || (item as WatchlistItem).kind === 'protocol'),
    );
  } catch {
    return [];
  }
}

export function useWatchlist() {
  const [items, setItems] = useState<WatchlistItem[]>(readWatchlist);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch {
      // Local persistence can be unavailable in private browsing or restricted contexts.
    }
  }, [items]);

  const has = (id: string, kind: WatchlistKind) => items.some((item) => item.id === id && item.kind === kind);
  const toggle = (item: WatchlistItem) => {
    setItems((current) => hasInList(current, item) ? current.filter((entry) => entry.id !== item.id || entry.kind !== item.kind) : [...current, item]);
  };
  const remove = (item: WatchlistItem) => {
    setItems((current) => current.filter((entry) => entry.id !== item.id || entry.kind !== item.kind));
  };

  return { items, has, toggle, remove };
}

function hasInList(items: WatchlistItem[], item: WatchlistItem) {
  return items.some((entry) => entry.id === item.id && entry.kind === item.kind);
}
