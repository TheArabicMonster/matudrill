import type { CSSProperties } from 'react';

import { cropUrl } from '../api';
import type { Crop } from '../types';
import s from './CropImage.module.css';

/**
 * Découpe du polycopié à 0,63 × sa largeur en pixels, sans jamais dépasser
 * la colonne. Énoncé, sous-questions et réponses partagent cette échelle.
 */
export function CropImage({
  crop,
  alt,
  className,
  scale = 0.63,
  eager = false,
}: {
  crop: Crop;
  alt: string;
  className?: string;
  scale?: number;
  eager?: boolean;
}) {
  return (
    <img
      src={cropUrl(crop.src)}
      alt={alt}
      width={crop.w}
      height={crop.h}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      className={className ? `${s.crop} ${className}` : s.crop}
      style={{ width: `${Math.round(crop.w * scale)}px` } as CSSProperties}
    />
  );
}
