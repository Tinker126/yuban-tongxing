module.exports = {
  apps: [{ name: 'yuban-tongxing', script: 'server.js', cwd: __dirname,
    instances: 1, exec_mode: 'fork', autorestart: true, max_memory_restart: '512M',
    kill_timeout: 65000, time: true, env: { NODE_ENV: 'production' }
  }]
};
