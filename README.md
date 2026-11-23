# Matudrill

Outil d'entraînement pour réviser sur un recueil d'exercices PDF : l'application
affiche l'énoncé, puis la solution, et l'élève s'auto-évalue. Les exercices ne
sont pas retapés mais découpés en images depuis le polycopié, donc les formules
mathématiques restent exactes.

Les polycopiés ne sont pas distribués avec ce dépôt. Le pipeline fonctionne avec
tout PDF de mise en page comparable, placé dans `pdfs/`.

## Ce que fait l'application

- **Bibliothèque** : trois matières, liste dense groupée par section, recherche,
  filtre « à revoir », sélection par numéro (`1.3–1.8, 2.4`), panier de session
  persistant.
- **Session** en mode *pas à pas* (énoncé, solution, auto-évaluation juste /
  partiel / faux) ou *tout afficher* (solutions révélables une par une).
- **Chronomètre** par exercice, mis en pause quand l'onglet passe en arrière-plan.
- **Bilan** de fin de session : exercices à revoir, temps par exercice.
- **Import** : file des découpes douteuses, vérification et recadrage manuel
  depuis la page du PDF (la découpe corrigée est re-rendue et conservée).
- Mode nuit, navigation clavier complète, interface utilisable sur tablette.

## Comment ça marche

```
pdfs/            PDF sources (non versionnés)
extract/         pipeline Python : PDF → catalog.json + crops/*.png
test-data/       catalogue de démonstration versionné (2 exercices)
data/            sortie réelle du pipeline (non versionnée)
app/
  server/        API Hono + SQLite + rendu PDF à la demande
  web/           interface React (Vite, CSS Modules)
app-data/        ce que l'application écrit : base, découpes corrigées, pages
```

Le pipeline repère les titres (`Exercice 1.3`, `Solution 1.3`), les marqueurs de
sous-questions (`a)`, `(b)`, `1.`) et découpe chaque zone en image à 150 dpi. Il
publie pour chaque zone son rectangle en points PDF, ce qui permet à
l'application de la re-rendre depuis le PDF sans relancer Python.

## Démarrage

Prérequis : Node.js 22, npm, Poppler (`sudo apt install poppler-utils`).

```bash
cd app
npm install
npm run dev
```

Front sur `http://localhost:5173`, API sur `http://localhost:3230`. Le serveur
lit `test-data/` par défaut, donc l'application démarre sans le pipeline.

Commandes :

```bash
npm run build      # front compilé puis serveur compilé
npm start          # serveur seul : API, front, découpes
npm test           # tests serveur et front (Vitest)
npm run typecheck
```

## Produire ses propres données

Prérequis : Python 3.13, [uv](https://docs.astral.sh/uv/), et les PDF dans
`pdfs/algebre.pdf`, `pdfs/geometrie.pdf`, `pdfs/physique.pdf`.

```bash
cd extract
uv venv .venv
uv pip install --python .venv/bin/python pymupdf pytest

.venv/bin/python run.py                                     # les trois matières
.venv/bin/python run.py --subject algebre --only 1.1,1.2    # mise au point
.venv/bin/python -m pytest tests -q
```

Sorties : `data/catalog.json`, `data/crops/`, `data/report.md` (compteurs et
contrôles de blanchiment) et `data/review/` (planches de vérification visuelle).
Pour travailler sur ces données : `DATA_DIR=../../data npm run dev`.

## API

Serveur sur `127.0.0.1:3230` (`HOST` et `PORT` configurables). Pas
d'authentification : à exposer sur un réseau privé uniquement.

| Méthode | Route | Rôle |
|---|---|---|
| GET | `/api/catalog` | catalogue fusionné avec l'état utilisateur |
| POST | `/api/sessions` | création d'une session d'exercices |
| POST | `/api/attempts` | auto-évaluation d'une sous-question |
| PUT | `/api/exercises/:id/crops/:slot` | recadrage manuel d'une découpe |

Les autres routes (bilan de session, chronomètre, pages PDF, validation) sont
décrites dans `app/server/src/app.ts`.

## Base de données

SQLite, fichier `app-data/matudrill.db` :

| Table | Contenu |
|---|---|
| `attempts` | historique des auto-évaluations (`ok`, `mid`, `ko`) |
| `sessions`, `session_items` | sessions, ordre des exercices, temps cumulé |
| `verifications` | découpes validées à la main |
| `crop_overrides` | découpes refaites depuis le PDF |

Le statut d'un exercice n'est pas stocké : il est dérivé des derniers résultats
de ses sous-questions (tout juste → réussi, au moins un faux → à revoir).

## Déploiement

```bash
cd app && npm run build
pm2 start ecosystem.config.cjs
```

Le process sert l'API, le front compilé et les images, avec `DATA_DIR=./data-live`.

## Structure du dépôt

```
extract/       pipeline Python (modules de mise en page, découpe, rendu)
app/server/    API, accès SQLite, rendu PDF, tests
app/web/       pages React, composants, hooks, état
test-data/     catalogue de démonstration
```

## Licence

MIT (voir `LICENSE`). La licence couvre le code du dépôt ; les exercices et
leurs découpes dans `test-data/` proviennent d'un polycopié et restent la
propriété de leur auteur.
