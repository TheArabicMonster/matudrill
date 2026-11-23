import { useCallback, useEffect, useRef, useState } from 'react';

type AsyncState<T> =
  | { status: 'loading'; data: null; error: null }
  | { status: 'ready'; data: T; error: null }
  | { status: 'error'; data: null; error: string };

export type AsyncResult<T> = AsyncState<T> & {
  reload: () => void;
};

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return 'Impossible de charger les données. Réessaie.';
}

/**
 * Charge des données et expose les trois états de l'écran :
 * chargement (squelette), prêt, erreur avec action de reprise.
 */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[]): AsyncResult<T> {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading', data: null, error: null });
  const [attempt, setAttempt] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    let alive = true;
    setState({ status: 'loading', data: null, error: null });
    loaderRef.current().then(
      (data) => {
        if (alive) setState({ status: 'ready', data, error: null });
      },
      (error: unknown) => {
        if (alive) setState({ status: 'error', data: null, error: messageOf(error) });
      },
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, attempt]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);

  return { ...state, reload };
}

export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title ? `${title} — Matudrill` : 'Matudrill';
  }, [title]);
}
