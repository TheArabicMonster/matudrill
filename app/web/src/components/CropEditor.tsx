import { ChevronLeft, ChevronRight, Loader, Minus, Plus, RotateCcw, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../api';
import u from './ui.module.css';
import { cx } from '../lib/cx';
import {
  LEGACY_PAGE_DPI,
  MAX_ZOOM,
  MIN_ZOOM,
  nextZoomStep,
  pageScale,
  previewGeometry,
  SCREEN_PX_PER_PT,
  ZOOM_STEPS,
} from '../lib/preview';
import type { Crop, Exercise, PdfPage, Rect, Subject } from '../types';
import s from './CropEditor.module.css';

/** Largeur/hauteur minimale d'une découpe, comme le serveur. */
const MIN_PT = 8;

const DEFAULT_MARGIN_PT = 56;
const DEFAULT_HEIGHT_PT = 120;

/** Facteur d'un cran de molette avec Ctrl/⌘. */
const WHEEL_ZOOM_FACTOR = 1.1;

type ZoomMode = 'width' | 'page' | 'manual';

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

const HANDLES: { id: Handle; label: string }[] = [
  { id: 'nw', label: 'coin haut gauche' },
  { id: 'n', label: 'bord haut' },
  { id: 'ne', label: 'coin haut droit' },
  { id: 'e', label: 'bord droit' },
  { id: 'se', label: 'coin bas droit' },
  { id: 's', label: 'bord bas' },
  { id: 'sw', label: 'coin bas gauche' },
  { id: 'w', label: 'bord gauche' },
];

const CURSOR: Record<Handle, string> = {
  nw: 'nwse-resize',
  n: 'ns-resize',
  ne: 'nesw-resize',
  e: 'ew-resize',
  se: 'nwse-resize',
  s: 'ns-resize',
  sw: 'nesw-resize',
  w: 'ew-resize',
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function defaultRect(widthPt: number, heightPt: number): Rect {
  const top = Math.round((heightPt - DEFAULT_HEIGHT_PT) / 2);
  return [DEFAULT_MARGIN_PT, top, Math.round(widthPt - DEFAULT_MARGIN_PT), top + DEFAULT_HEIGHT_PT];
}

/** Ramène un cadre dans la page, avec une taille minimale de 8 pt. */
function clampRect(rect: Rect, widthPt: number, heightPt: number): Rect {
  const [x0, y0, x1, y1] = rect;
  const left = round1(clamp(x0, 0, widthPt - MIN_PT));
  const right = round1(clamp(x1, left + MIN_PT, widthPt));
  const top = round1(clamp(y0, 0, heightPt - MIN_PT));
  const bottom = round1(clamp(y1, top + MIN_PT, heightPt));
  return [left, top, right, bottom];
}

type Drag =
  | { mode: 'move'; pointerId: number; start: { x: number; y: number }; origin: Rect }
  | { mode: 'resize'; pointerId: number; handle: Handle; origin: Rect }
  | { mode: 'new'; pointerId: number; anchor: { x: number; y: number } };

export interface CropEditorProps {
  exerciseId: string;
  slot: string;
  title: string;
  subject: Subject;
  crop: Crop | null;
  page: number;
  onClose: () => void;
  onChanged: (exercise: Exercise) => void;
}

/**
 * Éditeur plein écran : page du PDF à gauche, cadre ajustable à la souris, au
 * doigt ou au clavier ; aperçu et coordonnées en points à droite.
 */
export function CropEditor({
  exerciseId,
  slot,
  title,
  subject,
  crop,
  page: initialPage,
  onClose,
  onChanged,
}: CropEditorProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);

  const [page, setPage] = useState(initialPage);
  const [info, setInfo] = useState<PdfPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);
  const [rect, setRect] = useState<Rect | null>(crop?.rect ?? null);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [reloadToken, setReloadToken] = useState(0);
  const [zoomMode, setZoomMode] = useState<ZoomMode>('width');
  const [manualScale, setManualScale] = useState(1);
  /** Largeur/hauteur utiles de la zone de page et du panneau d'aperçu. */
  const [area, setArea] = useState({ width: 0, height: 0 });
  const [previewWidth, setPreviewWidth] = useState(0);
  const focusedOnce = useRef(false);
  const scaleRef = useRef(0);
  const needsCenter = useRef(true);

  const manual = crop?.manual === true;
  const maxPage = Math.max(subject.pages, 1);
  const titleId = `crop-editor-${exerciseId}-${slot.replace(/[^a-zA-Z0-9]/g, '-')}`;

  // Cadre et page en points (l'échelle d'affichage n'entre pas dans ces calculs).
  const [x0, y0, x1, y1] = rect ?? [0, 0, 0, 0];
  const width = Math.max(x1 - x0, MIN_PT);
  const height = Math.max(y1 - y0, MIN_PT);
  const pageWidth = info?.widthPt ?? 1;
  const pageHeight = info?.heightPt ?? 1;
  const percent = (value: number, total: number) => `${(value / total) * 100}%`;

  // Zoom : 100 % = page à sa taille réelle (96 dpi CSS), « ajuster » remplit
  // la zone visible, le reste défile.
  const scale = pageScale(
    zoomMode,
    manualScale,
    { widthPt: pageWidth, heightPt: pageHeight },
    area,
  );
  const zoomPercent = Math.round(scale * 100);
  // Les paliers vont de 75 % à 300 % : au-delà (molette), les boutons s'arrêtent.
  const canZoomOut = scale > ZOOM_STEPS[0] + 0.005;
  const canZoomIn = scale < ZOOM_STEPS[ZOOM_STEPS.length - 1] - 0.005;

  function zoomTo(next: number) {
    setManualScale(clamp(next, MIN_ZOOM, MAX_ZOOM));
    setZoomMode('manual');
  }

  function zoomStep(direction: 1 | -1) {
    const next = nextZoomStep(scale, direction);
    if (Math.abs(next - scale) < 0.001) return;
    zoomTo(next);
  }

  // Dialogue natif : focus piégé par le navigateur, Échap = annuler.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    function onCancel(event: Event) {
      event.preventDefault();
      onClose();
    }
    dialog.addEventListener('cancel', onCancel);
    return () => dialog.removeEventListener('cancel', onCancel);
  }, [onClose]);

  // Chargement de la page du PDF demandée.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setPageError(null);
    api.pdfPage(subject.id, page).then(
      (data) => {
        if (!alive) return;
        setInfo(data);
        setLoading(false);
        setRect((current) => clampRect(current ?? defaultRect(data.widthPt, data.heightPt), data.widthPt, data.heightPt));
      },
      (caught: unknown) => {
        if (!alive) return;
        setLoading(false);
        setPageError(
          caught instanceof Error ? caught.message : 'Cette page n’a pas pu être rendue. Réessaie.',
        );
      },
    );
    return () => {
      alive = false;
    };
  }, [page, subject.id, reloadToken]);

  // Focus sur la zone de dessin dès que la page est prête (flèches actives).
  useEffect(() => {
    if (!info || focusedOnce.current) return;
    focusedOnce.current = true;
    stageRef.current?.focus({ preventScroll: true });
  }, [info]);

  // Mesure de la zone visible (le cadre doit remplir la largeur, le reste
  // défile) et du panneau d'aperçu (l'aperçu se cale sur sa largeur réelle).
  useEffect(() => {
    function measure(element: HTMLElement): { width: number; height: number } {
      const style = getComputedStyle(element);
      const width = element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const height = element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      return { width: Math.max(width, 0), height: Math.max(height, 0) };
    }

    const viewport = viewportRef.current;
    const preview = previewRef.current;
    if (!viewport || !preview) return;

    const syncArea = () => {
      const next = measure(viewport);
      setArea((current) =>
        Math.abs(current.width - next.width) < 0.5 && Math.abs(current.height - next.height) < 0.5 ? current : next,
      );
    };
    const syncPreview = () => setPreviewWidth(measure(preview).width);

    syncArea();
    syncPreview();
    const observer = new ResizeObserver(() => {
      syncArea();
      syncPreview();
    });
    observer.observe(viewport);
    observer.observe(preview);
    return () => observer.disconnect();
  }, [info]);

  // Ctrl/⌘ + molette : zoom continu autour de la vue courante.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    function onWheel(event: WheelEvent) {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const factor = event.deltaY < 0 ? WHEEL_ZOOM_FACTOR : 1 / WHEEL_ZOOM_FACTOR;
      setManualScale(clamp(scaleRef.current * factor, MIN_ZOOM, MAX_ZOOM));
      setZoomMode('manual');
    }
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, []);

  // Le zoom manuel part toujours de l'échelle affichée (molette comprise).
  useEffect(() => {
    scaleRef.current = scale;
  }, [scale]);

  // À l'ouverture, à chaque changement de page et quand on change de mode
  // d'ajustement, le cadre courant revient au centre de la vue.
  useEffect(() => {
    needsCenter.current = true;
  }, [info?.image, zoomMode]);

  useEffect(() => {
    if (!needsCenter.current || !info || !rect || scale <= 0) return;
    const handle = requestAnimationFrame(() => {
      const viewport = viewportRef.current;
      const frame = frameRef.current;
      if (!viewport || !frame || !needsCenter.current) return;
      const outer = viewport.getBoundingClientRect();
      const inner = frame.getBoundingClientRect();
      viewport.scrollLeft += inner.left + inner.width / 2 - (outer.left + outer.width / 2);
      viewport.scrollTop += inner.top + inner.height / 2 - (outer.top + outer.height / 2);
      needsCenter.current = false;
    });
    return () => cancelAnimationFrame(handle);
  }, [info, rect, scale]);

  function toPt(clientX: number, clientY: number): { x: number; y: number } | null {
    const img = imgRef.current;
    if (!img || !info) return null;
    const box = img.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return null;
    return {
      x: ((clientX - box.left) / box.width) * info.widthPt,
      y: ((clientY - box.top) / box.height) * info.heightPt,
    };
  }

  const update = useCallback(
    (next: Rect) => {
      if (!info) return;
      setRect(clampRect(next, info.widthPt, info.heightPt));
    },
    [info],
  );

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!info || !rect) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const pt = toPt(event.clientX, event.clientY);
    if (!pt) return;

    event.preventDefault();
    stageRef.current?.setPointerCapture(event.pointerId);

    const inside = pt.x >= rect[0] && pt.x <= rect[2] && pt.y >= rect[1] && pt.y <= rect[3];
    drag.current = inside
      ? { mode: 'move', pointerId: event.pointerId, start: pt, origin: rect }
      : { mode: 'new', pointerId: event.pointerId, anchor: pt };

    if (!inside) {
      update([pt.x, pt.y, pt.x, pt.y]);
    }
    stageRef.current?.focus({ preventScroll: true });
  }

  function onHandlePointerDown(event: React.PointerEvent<HTMLDivElement>, handle: Handle) {
    if (!info || !rect) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    stageRef.current?.setPointerCapture(event.pointerId);
    drag.current = { mode: 'resize', pointerId: event.pointerId, handle, origin: rect };
    stageRef.current?.focus({ preventScroll: true });
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!current || !info || current.pointerId !== event.pointerId) return;
    const pt = toPt(event.clientX, event.clientY);
    if (!pt) return;
    event.preventDefault();

    const { widthPt, heightPt } = info;

    if (current.mode === 'move') {
      const [x0, y0, x1, y1] = current.origin;
      const width = x1 - x0;
      const height = y1 - y0;
      const left = clamp(current.origin[0] + (pt.x - current.start.x), 0, widthPt - width);
      const top = clamp(current.origin[1] + (pt.y - current.start.y), 0, heightPt - height);
      update([left, top, left + width, top + height]);
      return;
    }

    if (current.mode === 'new') {
      const { anchor } = current;
      let left = Math.min(anchor.x, pt.x);
      let right = Math.max(anchor.x, pt.x);
      let top = Math.min(anchor.y, pt.y);
      let bottom = Math.max(anchor.y, pt.y);
      if (right - left < MIN_PT) {
        if (pt.x >= anchor.x) right = Math.min(left + MIN_PT, widthPt);
        else left = Math.max(right - MIN_PT, 0);
      }
      if (bottom - top < MIN_PT) {
        if (pt.y >= anchor.y) bottom = Math.min(top + MIN_PT, heightPt);
        else top = Math.max(bottom - MIN_PT, 0);
      }
      update([left, top, right, bottom]);
      return;
    }

    const [x0, y0, x1, y1] = current.origin;
    const next: Rect = [x0, y0, x1, y1];
    if (current.handle.includes('w')) next[0] = clamp(pt.x, 0, x1 - MIN_PT);
    if (current.handle.includes('e')) next[2] = clamp(pt.x, x0 + MIN_PT, widthPt);
    if (current.handle.includes('n')) next[1] = clamp(pt.y, 0, y1 - MIN_PT);
    if (current.handle.includes('s')) next[3] = clamp(pt.y, y0 + MIN_PT, heightPt);
    update(next);
  }

  function endDrag(event?: React.PointerEvent<HTMLDivElement>) {
    if (event && drag.current && drag.current.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event) {
      try {
        stageRef.current?.releasePointerCapture(event.pointerId);
      } catch {
        /* le pointeur est déjà relâché */
      }
    }
  }

  // Un état de glisser oublié ne doit jamais rester actif.
  useEffect(() => {
    function clear() {
      drag.current = null;
    }
    window.addEventListener('blur', clear);
    return () => window.removeEventListener('blur', clear);
  }, []);

  function onStageKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!info || !rect) return;
    const step = event.shiftKey ? 10 : 1;
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();

    const [x0, y0, x1, y1] = rect;
    let next: Rect = [x0, y0, x1, y1];
    if (event.altKey) {
      if (event.key === 'ArrowLeft') next[2] = x1 - step;
      if (event.key === 'ArrowRight') next[2] = x1 + step;
      if (event.key === 'ArrowUp') next[3] = y1 - step;
      if (event.key === 'ArrowDown') next[3] = y1 + step;
    } else {
      if (event.key === 'ArrowLeft') next = [x0 - step, y0, x1 - step, y1];
      if (event.key === 'ArrowRight') next = [x0 + step, y0, x1 + step, y1];
      if (event.key === 'ArrowUp') next = [x0, y0 - step, x1, y1 - step];
      if (event.key === 'ArrowDown') next = [x0, y0 + step, x1, y1 + step];
    }
    update(next);
    const clamped = clampRect(next, info.widthPt, info.heightPt);
    setAnnouncement(
      `Cadre : haut ${Math.round(clamped[1])}, bas ${Math.round(clamped[3])}, gauche ${Math.round(clamped[0])}, droite ${Math.round(clamped[2])} points.`,
    );
  }

  function onField(key: 'top' | 'bottom' | 'left' | 'right', value: number) {
    if (!rect) return;
    const next: Rect = [...rect];
    if (key === 'left') next[0] = value;
    if (key === 'top') next[1] = value;
    if (key === 'right') next[2] = value;
    if (key === 'bottom') next[3] = value;
    update(next);
  }

  async function save() {
    if (!rect || status === 'saving' || status === 'saved') return;
    setStatus('saving');
    setError(null);
    try {
      const result = await api.putCrop(exerciseId, slot, {
        page,
        rect: rect.map((value) => Math.round(value)) as Rect,
      });
      onChanged(result.exercise);
      setStatus('saved');
      setAnnouncement('Découpe enregistrée pour tous.');
      window.setTimeout(onClose, 700);
    } catch (caught) {
      setStatus('idle');
      setError(caught instanceof Error ? caught.message : 'L’enregistrement a échoué. Réessaie.');
    }
  }

  async function reset() {
    if (status === 'saving' || status === 'saved') return;
    setStatus('saving');
    setError(null);
    try {
      const result = await api.deleteCrop(exerciseId, slot);
      onChanged(result.exercise);
      setStatus('saved');
      setAnnouncement('Découpe automatique rétablie.');
      window.setTimeout(onClose, 700);
    } catch (caught) {
      setStatus('idle');
      setError(caught instanceof Error ? caught.message : 'Le retour à la découpe automatique a échoué.');
    }
  }

  const preview =
    info && rect && previewWidth > 0
      ? previewGeometry(
          rect,
          { widthPt: info.widthPt, heightPt: info.heightPt },
          info.dpi ?? LEGACY_PAGE_DPI,
          previewWidth,
        )
      : null;

  return (
    <dialog ref={dialogRef} className={s.dialog} aria-labelledby={titleId}>
      <div className={s.layout}>
        <section className={s.pageCol} aria-label="Page du polycopié">
          <div className={s.zoomBar} role="group" aria-label="Zoom de la page">
            <div className={s.zoomSteps}>
              <button
                type="button"
                className={cx(u.btn, u.ghost, u.iconOnly)}
                onClick={() => zoomStep(-1)}
                aria-label="Réduire le zoom"
                disabled={!canZoomOut}
              >
                <Minus size={16} strokeWidth={2} aria-hidden="true" />
              </button>
              <span className={s.zoomValue} aria-live="polite">
                {zoomPercent} %
              </span>
              <button
                type="button"
                className={cx(u.btn, u.ghost, u.iconOnly)}
                onClick={() => zoomStep(1)}
                aria-label="Agrandir le zoom"
                disabled={!canZoomIn}
              >
                <Plus size={16} strokeWidth={2} aria-hidden="true" />
              </button>
            </div>
            <div className={s.zoomFit}>
              <button
                type="button"
                className={cx(u.btn, zoomMode === 'width' ? u.primary : u.secondary)}
                onClick={() => setZoomMode('width')}
                aria-pressed={zoomMode === 'width'}
              >
                Ajuster à la largeur
              </button>
              <button
                type="button"
                className={cx(u.btn, zoomMode === 'page' ? u.primary : u.secondary)}
                onClick={() => setZoomMode('page')}
                aria-pressed={zoomMode === 'page'}
              >
                Ajuster à la page
              </button>
            </div>
          </div>

          <div ref={viewportRef} className={s.viewport} aria-busy={loading}>
            {loading ? <p className={s.stageMessage}>Chargement de la page…</p> : null}
            {pageError ? (
              <div className={s.stageError} role="alert">
                <p>{pageError}</p>
                <button
                  type="button"
                  className={cx(u.btn, u.secondary)}
                  onClick={() => setReloadToken((value) => value + 1)}
                >
                  Réessayer
                </button>
              </div>
            ) : null}
            {info && !loading ? (
              <div
                ref={stageRef}
                className={s.stage}
                tabIndex={0}
                role="group"
                aria-label="Cadre de découpe : glisse pour déplacer ou tracer, flèches pour déplacer, Maj pour 10 points, Alt avec les flèches pour redimensionner."
                style={{
                  width: `${pageWidth * SCREEN_PX_PER_PT * scale}px`,
                  height: `${pageHeight * SCREEN_PX_PER_PT * scale}px`,
                }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onLostPointerCapture={() => {
                  drag.current = null;
                }}
                onKeyDown={onStageKeyDown}
              >
                <img
                  ref={imgRef}
                  src={info.image}
                  alt={`Page ${page} du polycopié ${subject.name}`}
                  className={s.pageImage}
                  draggable={false}
                />

                {rect ? (
                  <>
                    <span
                      className={s.shade}
                      style={{ left: 0, top: 0, right: 0, height: percent(y0, pageHeight) }}
                      aria-hidden="true"
                    />
                    <span
                      className={s.shade}
                      style={{ left: 0, bottom: 0, right: 0, top: percent(y1, pageHeight) }}
                      aria-hidden="true"
                    />
                    <span
                      className={s.shade}
                      style={{ left: 0, top: percent(y0, pageHeight), width: percent(x0, pageWidth), height: percent(y1 - y0, pageHeight) }}
                      aria-hidden="true"
                    />
                    <span
                      className={s.shade}
                      style={{
                        left: percent(x1, pageWidth),
                        top: percent(y0, pageHeight),
                        right: 0,
                        height: percent(y1 - y0, pageHeight),
                      }}
                      aria-hidden="true"
                    />
                    <div
                      ref={frameRef}
                      className={s.frame}
                      style={{
                        left: percent(x0, pageWidth),
                        top: percent(y0, pageHeight),
                        width: percent(width, pageWidth),
                        height: percent(height, pageHeight),
                      }}
                    >
                      {HANDLES.map((handle) => (
                        <div
                          key={handle.id}
                          className={s.handle}
                          style={{
                            left: handle.id.includes('w') ? 0 : handle.id.includes('e') ? '100%' : '50%',
                            top: handle.id.includes('n') ? 0 : handle.id.includes('s') ? '100%' : '50%',
                            cursor: CURSOR[handle.id],
                          }}
                          onPointerDown={(event) => onHandlePointerDown(event, handle.id)}
                          aria-hidden="true"
                        />
                      ))}
                    </div>
                  </>
                ) : null}
              </div>
            ) : null}
          </div>

          <p className={s.hint}>
            Glisse le cadre ou trace un nouveau cadre ; les flèches le déplacent (Maj : 10 pt, Alt : redimensionner).
            Ctrl/⌘ + molette zoome la page.
          </p>

          <nav className={s.pageNav} aria-label="Navigation dans le PDF">
            <button
              type="button"
              className={cx(u.btn, u.secondary)}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
              disabled={page <= 1}
            >
              <ChevronLeft size={16} strokeWidth={2} aria-hidden="true" />
              Page précédente
            </button>
            <span className={s.pagePosition}>
              Page {page} sur {maxPage}
            </span>
            <button
              type="button"
              className={cx(u.btn, u.secondary)}
              onClick={() => setPage((value) => Math.min(maxPage, value + 1))}
              disabled={page >= maxPage}
            >
              Page suivante
              <ChevronRight size={16} strokeWidth={2} aria-hidden="true" />
            </button>
          </nav>
        </section>

        <aside className={s.side} aria-label="Aperçu et réglages">
          <header className={s.head}>
            <div>
              <h2 id={titleId} className={s.title}>
                Recadrer · {title}
              </h2>
              <p className={s.sub}>
                {subject.name} · page {page}
              </p>
            </div>
            <button
              type="button"
              className={cx(u.btn, u.ghost, u.iconOnly)}
              onClick={onClose}
              aria-label="Fermer l’éditeur"
            >
              <X size={20} strokeWidth={2} aria-hidden="true" />
            </button>
          </header>

          <h3 className={s.sectionTitle}>Aperçu du rendu</h3>
          <div ref={previewRef} className={s.preview}>
            {preview && info && rect ? (
              <div
                className={s.previewSurface}
                role="img"
                aria-label={`Aperçu du cadre : haut ${Math.round(y0)}, bas ${Math.round(y1)}, gauche ${Math.round(x0)}, droite ${Math.round(x1)} points.`}
                style={{
                  height: `${preview.height}px`,
                  backgroundImage: `url(${info.image})`,
                  backgroundPosition: preview.backgroundPosition,
                  backgroundSize: preview.backgroundSize,
                }}
              />
            ) : null}
          </div>

          <fieldset className={s.fields}>
            <legend className={s.legend}>Coordonnées en points</legend>
            <div className={s.fieldGrid}>
              <PointField label="Haut" value={y0} onCommit={(value) => onField('top', value)} />
              <PointField label="Bas" value={y1} onCommit={(value) => onField('bottom', value)} />
              <PointField label="Gauche" value={x0} onCommit={(value) => onField('left', value)} />
              <PointField label="Droite" value={x1} onCommit={(value) => onField('right', value)} />
            </div>
          </fieldset>

          <div className={s.actions}>
            <button
              type="button"
              className={cx(u.btn, u.primary)}
              onClick={() => void save()}
              disabled={!rect || status !== 'idle'}
            >
              {status === 'saving' ? <Loader size={16} strokeWidth={2} className={s.spinner} aria-hidden="true" /> : null}
              {status === 'saving'
                ? 'Enregistrement…'
                : status === 'saved'
                  ? 'Enregistrée'
                  : 'Enregistrer pour tous'}
            </button>
            <button type="button" className={cx(u.btn, u.secondary)} onClick={onClose} disabled={status === 'saving'}>
              Annuler
            </button>
            {manual ? (
              <button
                type="button"
                className={cx(u.btn, u.ghost, s.reset)}
                onClick={() => void reset()}
                disabled={status === 'saving'}
              >
                <RotateCcw size={16} strokeWidth={2} aria-hidden="true" />
                Revenir à la découpe automatique
              </button>
            ) : null}
          </div>

          {error ? (
            <p className={s.error} role="alert">
              {error}
              <button type="button" className={s.retry} onClick={() => void save()}>
                Réessayer
              </button>
            </p>
          ) : null}

          <p className="visually-hidden" aria-live="polite">
            {announcement}
          </p>
        </aside>
      </div>
    </dialog>
  );
}

function PointField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(Math.round(value)));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setDraft(String(Math.round(value)));
  }, [value, focused]);

  return (
    <label className={s.field}>
      <span>{label}</span>
      <span className={s.inputWrap}>
        <input
          type="number"
          inputMode="numeric"
          min={0}
          step={1}
          className={cx(u.input, s.numberInput)}
          value={draft}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            setDraft(String(Math.round(value)));
          }}
          onChange={(event) => {
            setDraft(event.target.value);
            const next = Number(event.target.value);
            if (event.target.value.trim() !== '' && Number.isFinite(next)) onCommit(next);
          }}
        />
        <span className={s.unit}>pt</span>
      </span>
    </label>
  );
}
