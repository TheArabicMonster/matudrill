import type {
  Catalog,
  CropUpdate,
  Exercise,
  PdfPage,
  Rect,
  ResolveNumbersResult,
  ResultValue,
  SessionDetail,
  SessionItem,
  SessionMode,
  SessionSummary,
} from './types';

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function parseError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error.length > 0) return body.error;
  } catch {
    /* réponse non JSON */
  }
  return 'Le serveur n’a pas répondu. Réessaie.';
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError('Connexion au serveur impossible. Vérifie qu’il tourne, puis réessaie.', 0);
  }
  if (!response.ok) {
    throw new ApiError(await parseError(response), response.status);
  }
  return (await response.json()) as T;
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

export const api = {
  catalog(): Promise<Catalog> {
    return request<Catalog>('/api/catalog');
  },

  exercise(id: string): Promise<{ exercise: Exercise }> {
    return request(`/api/exercises/${encodeURIComponent(id)}`);
  },

  createSession(body: {
    items: { exerciseId: string; parts: string[] }[];
    mode: SessionMode;
  }): Promise<{ id: string }> {
    return post('/api/sessions', body);
  },

  session(id: string): Promise<SessionDetail> {
    return request(`/api/sessions/${encodeURIComponent(id)}`);
  },

  summary(id: string): Promise<SessionSummary> {
    return request(`/api/sessions/${encodeURIComponent(id)}/summary`);
  },

  finish(id: string): Promise<{ ok: boolean }> {
    return post(`/api/sessions/${encodeURIComponent(id)}/finish`, {});
  },

  attempt(body: {
    exerciseId: string;
    part: string | null;
    result: ResultValue;
    sessionId: string;
  }): Promise<{ ok: boolean; status: string }> {
    return post('/api/attempts', body);
  },

  /** Chronomètre : temps cumulé d'un exercice dans une session. */
  putTime(
    sessionId: string,
    exerciseId: string,
    elapsedMs: number,
  ): Promise<{ ok: boolean; item: SessionItem; totalElapsedMs: number }> {
    return request(`/api/sessions/${encodeURIComponent(sessionId)}/items/${encodeURIComponent(exerciseId)}/time`, {
      method: 'PUT',
      body: JSON.stringify({ elapsedMs }),
    });
  },

  resolveNumbers(body: { subject: string; input: string }): Promise<ResolveNumbersResult> {
    return post('/api/resolve-numbers', body);
  },

  verify(id: string, verified: boolean): Promise<{ ok: boolean }> {
    return post(`/api/exercises/${encodeURIComponent(id)}/verify`, { verified });
  },

  pdfPage(subject: string, page: number): Promise<PdfPage> {
    return request(`/api/pdf/${encodeURIComponent(subject)}/pages/${page}`);
  },

  putCrop(
    exerciseId: string,
    slot: string,
    body: { page: number; rect: Rect },
  ): Promise<CropUpdate> {
    return request<CropUpdate>(
      `/api/exercises/${encodeURIComponent(exerciseId)}/crops/${encodeURIComponent(slot)}`,
      { method: 'PUT', body: JSON.stringify(body) },
    );
  },

  deleteCrop(exerciseId: string, slot: string): Promise<CropUpdate> {
    return request<CropUpdate>(
      `/api/exercises/${encodeURIComponent(exerciseId)}/crops/${encodeURIComponent(slot)}`,
      { method: 'DELETE' },
    );
  },
};

export function cropUrl(src: string): string {
  return src.startsWith('/') ? src : `/${src}`;
}

/**
 * Envoi « au mieux » du chronomètre quand la page s'en va (`pagehide`,
 * changement d'exercice) : `keepalive` laisse la requête aboutir sans réponse,
 * et un échec ne doit jamais gêner la navigation.
 */
export function sendTime(sessionId: string, exerciseId: string, elapsedMs: number): void {
  const url = `/api/sessions/${encodeURIComponent(sessionId)}/items/${encodeURIComponent(exerciseId)}/time`;
  try {
    void fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elapsedMs }),
      keepalive: true,
    }).catch(() => {
      /* le prochain envoi réessaiera */
    });
  } catch {
    /* rien à faire : on quitte la page */
  }
}
