import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import type { CartItem, Exercise, SessionMode } from '../types';

const STORAGE_KEY = 'matudrill.session.v1';

interface StoredCart {
  items: CartItem[];
  mode: SessionMode;
}

function isStoredCart(value: unknown): value is StoredCart {
  if (!value || typeof value !== 'object') return false;
  const raw = value as { items?: unknown; mode?: unknown };
  if (raw.mode !== 'step' && raw.mode !== 'all') return false;
  if (!Array.isArray(raw.items)) return false;
  return raw.items.every(
    (item) =>
      item &&
      typeof item === 'object' &&
      typeof (item as CartItem).exerciseId === 'string' &&
      Array.isArray((item as CartItem).parts) &&
      (item as CartItem).parts.every((part) => typeof part === 'string'),
  );
}

function readStorage(): StoredCart {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { items: [], mode: 'step' };
    const parsed: unknown = JSON.parse(raw);
    if (isStoredCart(parsed)) return parsed;
  } catch {
    /* stockage indisponible ou corrompu */
  }
  return { items: [], mode: 'step' };
}

export interface CartValue {
  items: CartItem[];
  mode: SessionMode;
  count: number;
  partCount: number;
  has: (exerciseId: string) => boolean;
  partsOf: (exerciseId: string) => string[];
  toggleExercise: (exercise: Exercise) => void;
  addExercise: (exercise: Exercise, parts?: string[]) => void;
  addExercises: (exercises: Exercise[]) => void;
  removeExercise: (exerciseId: string) => void;
  togglePart: (exercise: Exercise, label: string) => void;
  replaceItems: (items: CartItem[]) => void;
  move: (from: number, to: number) => void;
  setMode: (mode: SessionMode) => void;
  clear: () => void;
  lastAdded: number;
}

const CartContext = createContext<CartValue | null>(null);

export function CartProvider({ children }: { children: ReactNode }) {
  const [initial] = useState<StoredCart>(readStorage);
  const [items, setItems] = useState<CartItem[]>(initial.items);
  const [mode, setModeState] = useState<SessionMode>(initial.mode);
  const [lastAdded, setLastAdded] = useState(0);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ items, mode }));
    } catch {
      /* stockage plein ou désactivé : la session reste en mémoire */
    }
  }, [items, mode]);

  const has = useCallback((exerciseId: string) => items.some((item) => item.exerciseId === exerciseId), [items]);

  const partsOf = useCallback(
    (exerciseId: string) => items.find((item) => item.exerciseId === exerciseId)?.parts ?? [],
    [items],
  );

  const addExercise = useCallback((exercise: Exercise, parts?: string[]) => {
    const labels = parts ?? exercise.parts.map((part) => part.label);
    setItems((current) => {
      const existing = current.find((item) => item.exerciseId === exercise.id);
      if (!existing) return [...current, { exerciseId: exercise.id, parts: labels }];
      const merged = Array.from(new Set([...existing.parts, ...labels]));
      return current.map((item) =>
        item.exerciseId === exercise.id ? { exerciseId: exercise.id, parts: merged } : item,
      );
    });
  }, []);

  const removeExercise = useCallback((exerciseId: string) => {
    setItems((current) => current.filter((item) => item.exerciseId !== exerciseId));
  }, []);

  const toggleExercise = useCallback((exercise: Exercise) => {
    setItems((current) => {
      if (current.some((item) => item.exerciseId === exercise.id)) {
        return current.filter((item) => item.exerciseId !== exercise.id);
      }
      return [...current, { exerciseId: exercise.id, parts: exercise.parts.map((part) => part.label) }];
    });
  }, []);

  const addExercises = useCallback((exercises: Exercise[]) => {
    setItems((current) => {
      const next = [...current];
      for (const exercise of exercises) {
        const index = next.findIndex((item) => item.exerciseId === exercise.id);
        if (index === -1) {
          next.push({ exerciseId: exercise.id, parts: exercise.parts.map((part) => part.label) });
        }
      }
      return next;
    });
    setLastAdded(exercises.length);
  }, []);

  const togglePart = useCallback((exercise: Exercise, label: string) => {
    setItems((current) => {
      const item = current.find((entry) => entry.exerciseId === exercise.id);
      if (!item) {
        return [...current, { exerciseId: exercise.id, parts: [label] }];
      }
      const parts = item.parts.includes(label)
        ? item.parts.filter((part) => part !== label)
        : [...item.parts, label];
      const ordered = exercise.parts.map((part) => part.label).filter((partLabel) => parts.includes(partLabel));
      if (ordered.length === 0) return current.filter((entry) => entry.exerciseId !== exercise.id);
      return current.map((entry) =>
        entry.exerciseId === exercise.id ? { exerciseId: exercise.id, parts: ordered } : entry,
      );
    });
  }, []);

  const replaceItems = useCallback((next: CartItem[]) => setItems(next), []);

  const move = useCallback((from: number, to: number) => {
    setItems((current) => {
      if (from === to || from < 0 || from >= current.length || to < 0 || to >= current.length) return current;
      const next = [...current];
      const [moved] = next.splice(from, 1);
      if (!moved) return current;
      next.splice(to, 0, moved);
      return next;
    });
  }, []);

  const setMode = useCallback((next: SessionMode) => setModeState(next), []);
  const clear = useCallback(() => setItems([]), []);

  const partCount = useMemo(
    () => items.reduce((total, item) => total + Math.max(item.parts.length, 1), 0),
    [items],
  );

  const value = useMemo<CartValue>(
    () => ({
      items,
      mode,
      count: items.length,
      partCount,
      has,
      partsOf,
      toggleExercise,
      addExercise,
      addExercises,
      removeExercise,
      togglePart,
      replaceItems,
      move,
      setMode,
      clear,
      lastAdded,
    }),
    [
      items,
      mode,
      partCount,
      has,
      partsOf,
      toggleExercise,
      addExercise,
      addExercises,
      removeExercise,
      togglePart,
      replaceItems,
      move,
      setMode,
      clear,
      lastAdded,
    ],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartValue {
  const value = useContext(CartContext);
  if (!value) throw new Error('useCart doit être utilisé dans un CartProvider.');
  return value;
}
