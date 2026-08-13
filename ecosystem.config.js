// Cargar .env manualmente para asegurar que la API key esté disponible
const fs = require('fs');
const path = require('path');
function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Quitar comillas si las tiene
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
loadEnv(path.join(__dirname, '.env'));

module.exports = {
  apps: [{
    name: 'agt-contador-api',
    script: 'npx',
    args: 'tsx src/main.ts',
    cwd: __dirname + '/apps/api',
    env: {
      NODE_ENV: 'production',
      PORT: 3001,
      DATABASE_URL: process.env.DATABASE_URL || 'postgresql://contador:contador123@localhost:5433/agt_contador?schema=public',
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || '',
      JWT_SECRET: process.env.JWT_SECRET || '',
      CORS_ORIGIN: process.env.CORS_ORIGIN || '',
      ITBMS_RATE: process.env.ITBMS_RATE || '0.07',
      ITBMS_ENABLED: process.env.ITBMS_ENABLED || 'true',
      OPENWA_API_URL: process.env.OPENWA_API_URL || 'http://localhost:3000',
      OPENWA_API_KEY: process.env.OPENWA_API_KEY || '',
      OPENWA_SESSION_NAME: process.env.OPENWA_SESSION_NAME || 'contador507',
      APP_HOST: process.env.APP_HOST || 'http://147.93.145.67:3001',
      WA_BOT_PHONE: process.env.WA_BOT_PHONE || '+507 6403-4863',
      MAILER_API_URL: process.env.MAILER_API_URL || 'http://localhost:3004',
      // MAILER_API_KEY se carga vía dotenv desde .env (no en el bloque env:
      // PM2 congela aquí valores viejos y dotenv no sobreescribe vars existentes)
      APP_URL: process.env.APP_URL || 'https://contador507.com',
      FIELD_ENC_KEY: process.env.FIELD_ENC_KEY || '',
    },
  }],
};
