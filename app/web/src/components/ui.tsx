import { Circle, CircleCheck, CircleDashed, CircleX } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { cx } from '../lib/cx';
import type { Status } from '../types';
import s from './ui.module.css';

export const STATUS_META: Record<Status, { label: string; Icon: LucideIcon }> = {
  ok: { label: 'Réussi', Icon: CircleCheck },
  mid: { label: 'Partiel', Icon: CircleDashed },
  ko: { label: 'À revoir', Icon: CircleX },
  todo: { label: 'Jamais fait', Icon: Circle },
};

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className={s.kbd}>{children}</kbd>;
}

export function StatusPill({
  status,
  className,
  hideLabel = false,
}: {
  status: Status;
  className?: string;
  hideLabel?: boolean;
}) {
  const { label, Icon } = STATUS_META[status];
  return (
    <span className={cx(s.pill, s[`pill_${status}`], className)}>
      <Icon size={14} strokeWidth={2} aria-hidden="true" />
      {hideLabel ? <span className="visually-hidden">{label}</span> : label}
    </span>
  );
}

export function SubjectTag({ subjectId, name }: { subjectId: string; name: string }) {
  return (
    <span className={s.tag}>
      <span className={cx(s.dot, s[`dot_${subjectId}`])} aria-hidden="true" />
      {name}
    </span>
  );
}

export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  className,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div className={cx(s.segmented, className)} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={s.segButton}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Skeleton({ width, height = 20, className }: { width?: string; height?: number; className?: string }) {
  return (
    <span
      className={cx(s.skeleton, className)}
      style={{ width: width ?? '100%', height }}
      aria-hidden="true"
    />
  );
}

export function SkeletonList({ rows = 6 }: { rows?: number }) {
  return (
    <div className={s.skeletonStack} aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className={s.skeletonRow}>
          <Skeleton width="20px" height={20} />
          <Skeleton width="48px" height={16} />
          <Skeleton width="140px" height={16} />
          <Skeleton width="72px" height={16} />
        </div>
      ))}
    </div>
  );
}

export function ErrorState({
  title = 'Ces données n’ont pas pu être chargées',
  message,
  onRetry,
  compact = false,
}: {
  title?: string;
  message: string;
  onRetry: () => void;
  compact?: boolean;
}) {
  return (
    <div className={cx(s.state, compact && s.stateCompact)} role="alert">
      <CircleX size={22} strokeWidth={2} className={s.stateIcon} aria-hidden="true" />
      <div>
        <h2 className={s.stateTitle}>{title}</h2>
        <p className={s.stateText}>{message}</p>
      </div>
      <button type="button" className={cx(s.btn, s.primary)} onClick={onRetry}>
        Réessayer
      </button>
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
}: {
  icon: LucideIcon;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={s.state}>
      <Icon size={24} strokeWidth={2} className={s.stateIcon} aria-hidden="true" />
      <div>
        <h2 className={s.stateTitle}>{title}</h2>
        {children ? <div className={s.stateText}>{children}</div> : null}
      </div>
      {action}
    </div>
  );
}
