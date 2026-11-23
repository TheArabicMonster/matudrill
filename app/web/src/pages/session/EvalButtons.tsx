import { Check, Minus, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { cx } from '../../lib/cx';
import type { ResultValue } from '../../types';
import s from './SessionPage.module.css';

export const RESULT_OPTIONS: {
  value: ResultValue;
  label: string;
  key: string;
  Icon: LucideIcon;
  className: string;
}[] = [
  { value: 'ok', label: 'Juste', key: 'J', Icon: Check, className: s.resultOk },
  { value: 'mid', label: 'Partiel', key: 'P', Icon: Minus, className: s.resultMid },
  { value: 'ko', label: 'Faux', key: 'F', Icon: X, className: s.resultKo },
];

export function EvalButtons({
  value,
  onPick,
  label,
  disabled = false,
  compact = false,
}: {
  value: ResultValue | null;
  onPick: (result: ResultValue) => void;
  label: string;
  disabled?: boolean;
  compact?: boolean;
}) {
  return (
    <div className={cx(s.evalGroup, compact && s.evalGroupCompact)} role="group" aria-label={label}>
      {RESULT_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          className={cx(s.result, option.className)}
          aria-pressed={value === option.value}
          onClick={() => onPick(option.value)}
          disabled={disabled}
        >
          <option.Icon size={16} strokeWidth={2.4} aria-hidden="true" />
          <span>{option.label}</span>
          <kbd className={s.resultKbd}>{option.key}</kbd>
        </button>
      ))}
    </div>
  );
}
