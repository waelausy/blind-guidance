# Blind Guidance

Application web d'assistance pour personnes malvoyantes:
- capture video courte (2s/4s/8s) depuis le navigateur
- analyse IA via Gemini
- retour vocal en temps reel
- modes: `navigation`, `reading`, `focus`, `custom`

## Stack

- Frontend: HTML, CSS, JavaScript (vanilla)
- Backend: Node.js + Express
- IA: `@google/genai` (Gemini)
- Upload media: `multer`
- Config: `dotenv`
- Deploiement: Nginx + systemd + GitHub Actions

## Architecture

- Le backend sert aussi le frontend statique (`express.static`).
- Une seule appli Node tourne sur `PORT` (par defaut `3005`, chez toi `6111` via `.env`).
- En production, Nginx expose le site en HTTPS `:8443` et proxy `/api` vers `127.0.0.1:6111`.

## Prerequis

- Node.js 20+ recommande
- npm
- Cle Gemini

## Lancement local

1. Aller dans le backend:
```bash
cd backend
```

2. Creer/adapter `.env`:
```env
PORT=6111
GEMINI_API_KEY=your_gemini_api_key_here
APP_PASSWORD=optional_password
```

3. Installer les deps:
```bash
npm install
```

4. Lancer:
```bash
npm run dev
```

5. Ouvrir:
- `http://localhost:6111`

Important:
- Oui, une seule commande (`npm run dev`) suffit, car le backend sert aussi le frontend.

## Scripts npm (backend)

- `npm run dev`: demarrage avec watch
- `npm start`: demarrage normal

## Variables d'environnement (backend/.env)

- `PORT`: port d'ecoute du serveur Node
- `GEMINI_API_KEY`: cle API Gemini (obligatoire)
- `APP_PASSWORD`: mot de passe d'acces UI (optionnel, vide = acces libre)

## API principale

- `GET /api/health`
- `POST /api/auth`
- `POST /api/analyze`
- `POST /api/talk`
- `POST /api/custom-mode/build`
- `POST /api/reset`

## Arborescence

- `frontend/`: interface web (HTML/CSS/JS)
- `backend/`: serveur Express + appels Gemini
- `DOC/DEPLOYMENT.md`: guide de deploiement VPS
- `.github/workflows/deploy.yml`: pipeline de deploiement

## Securite

- Ne commit jamais `backend/.env`.
- Si une cle API a ete exposee, regenere-la immediatement.
