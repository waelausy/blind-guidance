#!/bin/bash
# Installation initiale unique sur le VPS
# Lancer: bash setup_vps.sh

set -e

echo "Setup Blind Guidance sur le VPS..."

# 1. Dossiers
mkdir -p ~/blind-guidance/backend
mkdir -p ~/blind-guidance/frontend

# 2. Node.js (si pas deja installe)
if ! command -v node &> /dev/null; then
    echo "Installation Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt install -y nodejs
fi

echo "Node $(node -v) / npm $(npm -v)"

# 3. Creer .env backend (a remplir manuellement)
if [ ! -f ~/blind-guidance/backend/.env ]; then
    cat > ~/blind-guidance/backend/.env << 'EOF'
PORT=6111
GEMINI_API_KEY=your_gemini_api_key_here
EOF
    echo "Edite ~/blind-guidance/backend/.env avec ta vraie GEMINI_API_KEY"
fi

# 4. Nginx
echo "Configuration Nginx..."
sudo cp /home/ubuntu/blind-guidance/nginx.conf /etc/nginx/sites-available/blind-guidance-8443
sudo ln -sf /etc/nginx/sites-available/blind-guidance-8443 /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
echo "Nginx configure sur port 8443 (HTTPS)"

# 5. Systemd service
echo "Configuration service systemd..."
sudo cp /home/ubuntu/blind-guidance/blind-guidance.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable blind-guidance
echo "Service blind-guidance active"

# 6. Install deps et demarrer
cd ~/blind-guidance/backend
npm install --omit=dev
sudo systemctl start blind-guidance
sudo systemctl status blind-guidance --no-pager

echo ""
echo "===================================="
echo "Setup termine"
echo "  Frontend: https://VPS_IP:8443"
echo "  Backend:  http://127.0.0.1:6111"
echo "===================================="
echo ""
echo "N'oublie pas: nano ~/blind-guidance/backend/.env"
echo "et ajouter ta GEMINI_API_KEY"
