# Deployment Guide — Blind Guidance

## Architecture

```
GitHub (main) → GitHub Actions → VPS (ubuntu@51.38.33.149)
                                   ├── nginx :6000 (blind-guidance-6000)
                                   │     ├── / → frontend/ (static HTML/JS/CSS)
                                   │     └── /api/ → proxy_pass → :6111
                                   └── node server.js :6111 (blind-guidance.service)
```

## Mapping des ports sur le VPS

| App            | Frontend public | Backend interne      |
|----------------|-----------------|----------------------|
| Studio Creatif | :7000           | 127.0.0.1:8000       |
| Voxtral        | :5000           | 127.0.0.1:5111       |
| **Blind Guidance** | **:6000**   | **127.0.0.1:6111**   |

## Ce qui est AUTOMATIQUE (GitHub Actions)

Chaque `git push` sur `main` déclenche `.github/workflows/deploy.yml` :

1. **Upload** des fichiers via `scp` : `backend/`, `frontend/`, `nginx.conf`, `blind-guidance.service`
2. **Sur le VPS** via SSH :
   - `npm install --omit=dev`
   - Configure nginx sur `:6000`
   - Installe/redémarre `blind-guidance.service`
   - Smoke tests

### Ce qui N'EST PAS écrasé :
- **`backend/.env`** — jamais copié, reste intact sur le VPS
- **Certificats SSL** — gérés par Let's Encrypt

## Setup initial (une seule fois)

### 1. Secrets GitHub à configurer

Dans `https://github.com/TON_USER/blind-guidance/settings/secrets/actions` → ajouter :

| Secret        | Valeur                          |
|---------------|---------------------------------|
| `VPS_HOST`    | `51.38.33.149`                  |
| `VPS_USER`    | `ubuntu`                        |
| `VPS_SSH_KEY` | Contenu de ta clé SSH privée    |

> Ces secrets existent déjà si tu les as créés pour studio-creatif-ai ou voxtral.
> Vérifie juste qu'ils s'appellent exactement pareil.

### 2. Premier déploiement sur le VPS

```bash
# Se connecter au VPS
ssh ubuntu@51.38.33.149

# Lancer le script de setup (après le premier push GitHub Actions)
bash ~/blind-guidance/setup_vps.sh

# Créer le .env avec ta clé Gemini
nano ~/blind-guidance/backend/.env
```

Contenu du `.env` :
```env
PORT=6111
GEMINI_API_KEY=ta_cle_gemini_ici
```

### 3. Vérification

```bash
sudo systemctl status blind-guidance --no-pager
curl -I http://127.0.0.1:6000/
curl -I http://51.38.33.149:6000/
sudo ss -tulpen | grep -E ':6000|:6111'
sudo nginx -t
```

## Workflow quotidien

```
1. Modifier le code localement
2. git add + git commit + git push origin main
3. GitHub Actions déploie automatiquement
4. Vérifier sur http://51.38.33.149:6000
```

## Logs et debug

```bash
# Logs du backend
sudo journalctl -u blind-guidance -n 100 --no-pager

# Redémarrer manuellement
sudo systemctl restart blind-guidance

# Logs nginx
sudo tail -50 /var/log/nginx/error.log
```
