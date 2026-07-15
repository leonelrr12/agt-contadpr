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
    if (!process.env[key]) {
      process.env[key] = value;
    }
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
      PORT: 3001,
      DATABASE_URL: process.env.DATABASE_URL || 'postgresql://contador:contador123@localhost:5433/agt_contador?schema=public',
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || '',
    },
  }],
};
