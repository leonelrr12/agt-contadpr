module.exports = {
  apps: [{
    name: 'agt-contador-api',
    script: 'npx',
    args: 'tsx src/main.ts',
    cwd: __dirname + '/apps/api',
    env: {
      PORT: 3001,
    },
  }],
};
