#!/bin/sh
# Respaldo completo (base de datos + PDF + comprobantes) en un solo .tar.gz.
# Uso, dentro de la carpeta del proyecto en el servidor:  sh tools/backup.sh [carpeta-destino]
# Copia consistente de la base con VACUUM INTO (no se detiene el servicio).
set -e
DEST="${1:-./respaldos}"
mkdir -p "$DEST"
STAMP=$(date +%Y-%m-%d_%H%M)
docker compose exec -T app node -e "
const fs=require('fs');try{fs.unlinkSync('/data/respaldo.db')}catch(e){}
const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/soim.db');d.exec(\"VACUUM INTO '/data/respaldo.db'\");d.close();"
docker compose exec -T app tar -czf - -C /data --exclude=soim.db --exclude=soim.db-wal --exclude=soim.db-shm . > "$DEST/soim_$STAMP.tar.gz"
docker compose exec -T app rm -f /data/respaldo.db
# Conserva los últimos 14 respaldos
ls -1t "$DEST"/soim_*.tar.gz 2>/dev/null | tail -n +15 | xargs -r rm -f
echo "Respaldo listo: $DEST/soim_$STAMP.tar.gz  (la base de datos va dentro como respaldo.db)"
