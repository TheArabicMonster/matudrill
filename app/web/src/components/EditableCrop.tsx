import { Crop, PenLine } from 'lucide-react';

import { CropImage } from './CropImage';
import { useCrops } from '../state/crops';
import { cx } from '../lib/cx';
import type { Crop as CropData, Subject } from '../types';
import s from './EditableCrop.module.css';

/**
 * Une découpe du polycopié avec son bouton « Recadrer » : ouvre l'éditeur sur
 * la page du PDF. Un emplacement sans image propose de la créer depuis le PDF.
 */
export function EditableCrop({
  exerciseId,
  slot,
  subject,
  crop,
  alt,
  title,
  page,
  scale,
  eager = false,
  className,
  imageClassName,
  variant = 'overlay',
}: {
  exerciseId: string;
  slot: string;
  subject: Subject;
  crop: CropData | null;
  alt: string;
  /** Nom lisible de l'image dans l'éditeur (« Sous-question a) »). */
  title: string;
  /** Page de départ quand aucune image n'existe encore. */
  page: number;
  scale?: number;
  eager?: boolean;
  className?: string;
  imageClassName?: string;
  /** `inline` : bouton icône à côté de l'image, pour les vignettes. */
  variant?: 'overlay' | 'inline';
}) {
  const { openEditor } = useCrops();

  function open() {
    openEditor({ exerciseId, slot, subject, crop, title, page });
  }

  if (!crop) {
    return (
      <span className={cx(s.missing, className)}>
        <button
          type="button"
          className={s.missingButton}
          onClick={open}
          aria-label={`Ajouter ${title.toLowerCase()} depuis le PDF`}
        >
          <Crop size={16} strokeWidth={2} aria-hidden="true" />
          Ajouter la réponse depuis le PDF
        </button>
      </span>
    );
  }

  return (
    <span className={cx(s.wrap, variant === 'inline' && s.wrapInline, className)}>
      <span className={s.imageWrap}>
        <CropImage crop={crop} alt={alt} scale={scale} eager={eager} className={imageClassName} />
        <button
          type="button"
          className={cx(s.trigger, variant === 'inline' && s.triggerInline)}
          onClick={open}
          aria-label={`Recadrer : ${alt}`}
        >
          <Crop size={16} strokeWidth={2} aria-hidden="true" />
          <span className={s.triggerLabel}>Recadrer</span>
        </button>
      </span>
      {crop.manual ? (
        <span className={s.manual}>
          <PenLine size={13} strokeWidth={2} aria-hidden="true" />
          Recadrée à la main
        </span>
      ) : null}
    </span>
  );
}
