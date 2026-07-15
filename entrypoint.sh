#!/bin/sh
set -e

echo "⏳ Waiting for PostgreSQL..."
until nc -z "$DB_HOST" 5432; do
  sleep 1
done
echo "✅ PostgreSQL ready"

cd /app/packages/prisma-schema

echo "⏳ Aplicando migraciones pendientes..."
npx prisma migrate deploy
echo "✅ Migraciones aplicadas"

echo "⏳ Seeding data..."
npx tsx prisma/seed.ts 2>/dev/null && echo "✅ Seed complete" || echo "⚠️ Seed skipped (data may already exist)"

cd /app/apps/api

echo "🚀 Starting API..."
npx tsx src/main.ts
