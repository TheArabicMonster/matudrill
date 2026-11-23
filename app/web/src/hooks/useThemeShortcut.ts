import { useEffect } from 'react';

import { useTheme } from '../state/theme';

/** Touche `N` : bascule le thème, hors saisie et hors éditeur ouvert. */
export function useThemeShortcut(): void {
  const { toggle } = useTheme();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key !== 'n' && event.key !== 'N') return;

      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (document.querySelector('dialog[open], [role="dialog"]')) return;

      event.preventDefault();
      toggle();
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggle]);
}
