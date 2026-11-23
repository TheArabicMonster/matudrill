import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { CropEditor } from '../components/CropEditor';
import type { Crop, Exercise, Subject } from '../types';

export interface CropRequest {
  exerciseId: string;
  slot: string;
  title: string;
  subject: Subject;
  crop: Crop | null;
  page: number;
}

interface CropsValue {
  /** Renvoie l'exercice à jour si une découpe a été refaite à la main. */
  apply: (exercise: Exercise) => Exercise;
  openEditor: (request: CropRequest) => void;
  /** Un éditeur plein écran est ouvert (le chronomètre se met en pause). */
  editorOpen: boolean;
}

const CropsContext = createContext<CropsValue | null>(null);

/**
 * Garde en mémoire les exercices dont une découpe vient d'être refaite :
 * l'image change partout sans recharger la page.
 */
export function CropsProvider({ children }: { children: ReactNode }) {
  const [overrides, setOverrides] = useState<Record<string, Exercise>>({});
  const [request, setRequest] = useState<CropRequest | null>(null);

  const apply = useCallback(
    (exercise: Exercise) => overrides[exercise.id] ?? exercise,
    [overrides],
  );

  const openEditor = useCallback((next: CropRequest) => setRequest(next), []);

  const changed = useCallback((exercise: Exercise) => {
    setOverrides((current) => ({ ...current, [exercise.id]: exercise }));
  }, []);

  const value = useMemo<CropsValue>(
    () => ({ apply, openEditor, editorOpen: request !== null }),
    [apply, openEditor, request],
  );

  return (
    <CropsContext.Provider value={value}>
      {children}
      {request ? (
        <CropEditor
          key={`${request.exerciseId}::${request.slot}`}
          exerciseId={request.exerciseId}
          slot={request.slot}
          title={request.title}
          subject={request.subject}
          crop={request.crop}
          page={request.page}
          onClose={() => setRequest(null)}
          onChanged={changed}
        />
      ) : null}
    </CropsContext.Provider>
  );
}

export function useCrops(): CropsValue {
  const value = useContext(CropsContext);
  if (!value) throw new Error('useCrops doit être utilisé dans CropsProvider.');
  return value;
}
