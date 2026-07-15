#!/bin/bash
# Disaster Recovery — Empaqueta todo lo necesario para reconstruir el servicio
# en un nuevo VPS en minutos.
# Uso: ./scripts/disaster-recovery.sh
# Genera: backups/disaster_recovery_YYYYMMDD_HHMMSS.tar.gz
set -euo pipefail

DR_DIR="$(cd "$(dirname "$0")/.." && pwd)/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
DR_FILE="$DR_DIR/disaster_recovery_$TIMESTAMP.tar.gz"
TEMP_DIR=$(mktemp -d)

echo "📦 Empaquetando disaster recovery..."

# 1. Backup de la base de datos (lo más reciente)
echo "   1/5 Base de datos..."
docker exec agt-contador-db-1 pg_dump \
  -U contador \
  -d agt_contador \
  --no-owner --no-acl \
  | gzip > "$TEMP_DIR/database.sql.gz"

# 2. Configuración sensible (.env, ecosystem, docker-compose, nginx)
echo "   2/5 Archivos de configuración..."
mkdir -p "$TEMP_DIR/config"
cp "$DR_DIR/../.env" "$TEMP_DIR/config/" 2>/dev/null || true
cp "$DR_DIR/../ecosystem.config.js" "$TEMP_DIR/config/"
cp "$DR_DIR/../docker-compose.yml" "$TEMP_DIR/config/"
cp "$DR_DIR/../Dockerfile" "$TEMP_DIR/config/"
cp "$DR_DIR/../entrypoint.sh" "$TEMP_DIR/config/"
cp "$DR_DIR/../nginx.conf" "$TEMP_DIR/config/"
cp /etc/nginx/sites-enabled/contador507.com "$TEMP_DIR/config/" 2>/dev/null || true

# 3. Scripts de restauración
echo "   3/5 Scripts de recuperación..."
cp "$DR_DIR/../scripts/restore-db.sh" "$TEMP_DIR/"
cp "$DR_DIR/../scripts/backup-db.sh" "$TEMP_DIR/"

# 4. Instrucciones
echo "   4/5 Instrucciones de recuperación..."
cat > "$TEMP_DIR/LEER_PRIMERO.md" << 'RECOVERY'
# Recuperación de Contador507

## Requisitos del nuevo VPS
- Ubuntu 22.04 o 24.04
- Docker + Docker Compose
- Node.js 20+
- Nginx
- PM2 (`npm install -g pm2`)
- Dominio contador507.com apuntando al nuevo servidor

## Pasos para reconstruir

### 1. Instalar dependencias
```bash
apt update && apt install -y docker.io docker-compose nginx nodejs npm
npm install -g pm2
```

### 2. Extraer este archivo
```bash
tar xzf disaster_recovery_*.tar.gz
cd recovery_*/
```

### 3. Configurar entorno
```bash
cp config/.env .env
# Editar .env si el VPS tiene IP/puertos diferentes
```

### 4. Levantar la base de datos
```bash
docker-compose up -d db
# Esperar ~10s a que esté lista
```

### 5. Restaurar los datos
```bash
./restore-db.sh database.sql.gz
```

### 6. Instalar dependencias y desplegar la app
```bash
npm install
npx prisma generate
```

### 7. Configurar nginx
```bash
cp config/contador507.com /etc/nginx/sites-enabled/
# Editar server_name si el dominio cambió
nginx -t && systemctl reload nginx
```

### 8. Instalar certificado SSL
```bash
certbot --nginx -d contador507.com -d www.contador507.com
```

### 9. Iniciar la API
```bash
pm2 start ecosystem.config.js
pm2 save
```

### 10. Verificar
```bash
curl https://contador507.com/api/health
# Debe responder: {"status":"ok"}
```

---

**Tiempo estimado de recuperación: 10-15 minutos.**
RECOVERY

# 5. Empaquetar todo
echo "   5/5 Comprimiendo..."
tar czf "$DR_FILE" -C "$(dirname "$TEMP_DIR")" "$(basename "$TEMP_DIR")"

# Limpiar
rm -rf "$TEMP_DIR"

SIZE=$(du -h "$DR_FILE" | cut -f1)
echo ""
echo "✅ Paquete de recuperación creado: $DR_FILE ($SIZE)"
echo ""
echo "⚠️  Guarda este archivo en un lugar SEGURO fuera de este servidor."
echo "   Recomendación: descárgalo a tu computadora o súbelo a Google Drive."
echo ""
echo "📋 Próximo paso automático: configurar backup diario + recovery semanal"
