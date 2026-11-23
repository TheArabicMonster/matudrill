module.exports = {
  apps: [{
    name: 'matudrill',
    cwd: __dirname + '/app/server',
    script: 'dist/index.js',
    env: { NODE_ENV: 'production', HOST: '10.66.66.1', PORT: '3230', DATA_DIR: __dirname + '/data-live' },
    max_memory_restart: '300M',
  }],
};
