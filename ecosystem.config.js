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
