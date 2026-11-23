import { NavLink } from 'react-router-dom';

import { cx } from '../lib/cx';
import { ThemeToggle } from './ThemeToggle';
import s from './AppBar.module.css';

export function AppBar() {
  return (
    <header className={s.bar}>
      <div className={s.inner}>
        <NavLink to="/" className={s.brand} aria-label="Matudrill, bibliothèque">
          <span className={s.mark} aria-hidden="true" />
          Matudrill
        </NavLink>
        <nav aria-label="Navigation principale" className={s.nav}>
          <NavLink to="/" end className={({ isActive }) => cx(s.link, isActive && s.active)}>
            Bibliothèque
          </NavLink>
          <NavLink to="/import" className={({ isActive }) => cx(s.link, isActive && s.active)}>
            Import
          </NavLink>
        </nav>
        <div className={s.actions}>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
