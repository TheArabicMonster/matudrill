import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { Link, Route, Routes, useLocation } from 'react-router-dom';

import { AppBar } from './components/AppBar';
import u from './components/ui.module.css';
import { useThemeShortcut } from './hooks/useThemeShortcut';
import { cx } from './lib/cx';
import { ImportExercisePage } from './pages/import/ImportExercisePage';
import { ImportPage } from './pages/import/ImportPage';
import { LibraryPage } from './pages/library/LibraryPage';
import { SessionEndPage } from './pages/session/SessionEndPage';
import { SessionPage } from './pages/session/SessionPage';
import s from './App.module.css';

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <>
      <AppBar />
      {children}
    </>
  );
}

function NotFoundPage() {
  return (
    <main className={s.notFound}>
      <div className={s.notFoundCard}>
        <h1>Cette page n’existe pas</h1>
        <p>Le lien est peut-être incomplet. Reviens à la bibliothèque pour retrouver tes exercices.</p>
        <Link to="/" className={cx(u.btn, u.primary)}>
          Retour à la bibliothèque
        </Link>
      </div>
    </main>
  );
}

export default function App() {
  useThemeShortcut();

  return (
    <>
      <a className="skip-link" href="#contenu">
        Aller au contenu
      </a>
      <ScrollToTop />
      <Routes>
        <Route
          path="/"
          element={
            <Shell>
              <LibraryPage />
            </Shell>
          }
        />
        <Route path="/session/:id" element={<SessionPage />} />
        <Route
          path="/session/:id/fin"
          element={
            <Shell>
              <SessionEndPage />
            </Shell>
          }
        />
        <Route
          path="/import"
          element={
            <Shell>
              <ImportPage />
            </Shell>
          }
        />
        <Route
          path="/import/:exerciseId"
          element={
            <Shell>
              <ImportExercisePage />
            </Shell>
          }
        />
        <Route
          path="*"
          element={
            <Shell>
              <NotFoundPage />
            </Shell>
          }
        />
      </Routes>
    </>
  );
}
