# Deployment Guide - Blind Guidance

## Architecture

```text
GitHub (main) -> GitHub Actions -> VPS
                               |- nginx :8443 (HTTPS)
                               |    |- /      -> frontend/ (static)
                               |    \- /api/  -> proxy_pass -> 127.0.0.1:6111
                               \- node server.js :6111 (systemd: blind-guidance)
```

Note:
- Le port public est `8443` (HTTPS).
- Le backend Node reste interne en `127.0.0.1:6111`.

## Ports (VPS)

| Service | Port |
|---|---|
| Frontend public (Nginx HTTPS) | `:8443` |
| Backend Node interne | `127.0.0.1:6111` |

## Deploiement automatique (GitHub Actions)

Chaque `git push` sur `main` declenche `.github/workflows/deploy.yml`:

1. Upload via `scp`: `backend/`, `frontend/`, `nginx.conf`, `blind-guidance.service`
2. Actions distantes:
   - `npm install --omit=dev` dans `backend`
   - mise a jour Nginx (`blind-guidance-8443`)
   - reload Nginx
   - installation/restart du service `blind-guidance`
   - smoke test

Ce qui n'est pas ecrase:
- `backend/.env` (non copie par le workflow)
- certificats Let's Encrypt

## Secrets GitHub requis

Configurer dans `Settings > Secrets and variables > Actions`:

| Secret | Description |
|---|---|
| `VPS_IP` | IP du VPS |
| `VPS_USER` | utilisateur SSH (ex: `ubuntu`) |
| `VPS_PASSWORD` | mot de passe SSH du user |

Important:
- Le workflow actuel utilise mot de passe (`sshpass`), pas de cle SSH.

## Setup initial VPS

1. Se connecter au VPS:

```bash
ssh ubuntu@<VPS_IP>
```

2. Lancer le script:

```bash
bash ~/blind-guidance/setup_vps.sh
```

3. Configurer `backend/.env`:

```bash
nano ~/blind-guidance/backend/.env
```

Exemple:

```env
PORT=6111
GEMINI_API_KEY=ta_cle_gemini
APP_PASSWORD=mot_de_passe_optionnel
```

## Verification

```bash
sudo systemctl status blind-guidance --no-pager
curl -I http://127.0.0.1:6111/api/health
curl -kI https://<VPS_IP>:8443/
sudo ss -tulpen | grep -E ':8443|:6111'
sudo nginx -t
```

## Workflow quotidien

1. Modifier le code localement.
2. `git add`, `git commit`, `git push origin main`.
3. GitHub Actions deploie automatiquement.
4. Verifier l'application sur `https://<VPS_IP>:8443`.

## Logs et debug

```bash
# Backend (systemd)
sudo journalctl -u blind-guidance -n 100 --no-pager

# Restart backend
sudo systemctl restart blind-guidance

# Nginx errors
sudo tail -50 /var/log/nginx/error.log
```
