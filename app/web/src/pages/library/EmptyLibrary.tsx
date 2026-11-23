import { FileText, Layers, Upload } from 'lucide-react';
import { Link } from 'react-router-dom';

import s from './EmptyLibrary.module.css';

export function EmptyLibrary() {
  return (
    <section className={s.wrap} aria-labelledby="empty-title">
      <div className={s.card}>
        <div className={s.main}>
          <header>
            <h1 id="empty-title">Aucun polycopié importé</h1>
            <p className={s.lead}>La bibliothèque se remplit à partir de tes PDF.</p>
          </header>

          <ol className={s.steps}>
            <li>
              <span className={s.stepNumber} aria-hidden="true">
                1
              </span>
              <div>
                <h2 className={s.stepTitle}>Importer les PDF</h2>
                <p className={s.stepText}>
                  Choisis les polycopiés d’Algèbre, de Géométrie &amp; trigonométrie et de Physique I, avec leurs
                  solutions. Matudrill repère chaque exercice et ses sous-questions.
                </p>
              </div>
            </li>
            <li>
              <span className={s.stepNumber} aria-hidden="true">
                2
              </span>
              <div>
                <h2 className={s.stepTitle}>Vérifier les découpes</h2>
                <p className={s.stepText}>
                  Chaque exercice est une image découpée dans le PDF, comme sur papier. Passe en revue les cadres et
                  corrige ceux qui coupent trop ou trop large.
                </p>
              </div>
            </li>
            <li>
              <span className={s.stepNumber} aria-hidden="true">
                3
              </span>
              <div>
                <h2 className={s.stepTitle}>S’entraîner</h2>
                <p className={s.stepText}>
                  Tape « 1.3–1.8, 2.4 » pour composer une session, écris tes réponses sur papier, puis révèle la
                  solution et note-toi : juste, partiel ou faux.
                </p>
              </div>
            </li>
          </ol>

          <div className={s.action}>
            <Link to="/import" className={s.importButton}>
              <Upload size={18} strokeWidth={2} aria-hidden="true" />
              Importer un polycopié
            </Link>
            <p className={s.hint}>Les PDF se déposent dans le dossier pdfs/ du projet, puis l’extraction remplit la bibliothèque.</p>
          </div>
        </div>

        <aside className={s.aside} aria-labelledby="empty-what">
          <h2 id="empty-what" className={s.asideTitle}>
            Ce que tu obtiendras
          </h2>
          <p className={s.asideText}>
            Chaque exercice arrive avec son énoncé, ses sous-questions et sa solution, découpés tels quels dans le
            polycopié.
          </p>
          <ul className={s.asideList}>
            <li>
              <FileText size={18} strokeWidth={2} aria-hidden="true" />
              <span>Énoncé et sous-questions du polycopié, sans OCR.</span>
            </li>
            <li>
              <Layers size={18} strokeWidth={2} aria-hidden="true" />
              <span>Solution complète ou réponse finale, selon ce que donne le polycopié.</span>
            </li>
          </ul>

          <hr className={s.rule} />

          <h2 className={s.asideTitle}>Formats acceptés</h2>
          <ul className={s.asideList}>
            <li>
              <FileText size={18} strokeWidth={2} aria-hidden="true" />
              <span>PDF avec texte sélectionnable (pas de scan).</span>
            </li>
            <li>
              <Layers size={18} strokeWidth={2} aria-hidden="true" />
              <span>Un fichier par polycopié ; solutions dans le même PDF ou dans un second.</span>
            </li>
          </ul>
        </aside>
      </div>
    </section>
  );
}
