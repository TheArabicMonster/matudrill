import { Moon, Sun } from 'lucide-react';

import { cx } from '../lib/cx';
import { useTheme } from '../state/theme';
import u from './ui.module.css';

/** Bouton icône 40 px : lune en clair, soleil en sombre. */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, toggle } = useTheme();
  const dark = theme === 'dark';
  const label = dark ? 'Activer le mode jour' : 'Activer le mode nuit';

  return (
    <button
      type="button"
      className={cx(u.btn, u.ghost, u.iconOnly, className)}
      onClick={toggle}
      aria-label={label}
      aria-pressed={dark}
      title={`${label} (N)`}
    >
      {dark ? (
        <Sun size={20} strokeWidth={2} aria-hidden="true" />
      ) : (
        <Moon size={20} strokeWidth={2} aria-hidden="true" />
      )}
    </button>
  );
}
