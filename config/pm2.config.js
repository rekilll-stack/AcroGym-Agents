'use strict';

module.exports = {
  apps: [
    // ─────────────────────────────
    // Агент 1: Lead Helper
    // ─────────────────────────────
    {
      name: 'lead-helper',
      script: 'agents/lead-helper/index.js',
      cwd: '/home/admin/acrogym',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      watch: false,
      error_file: 'logs/lead-helper-error.log',
      out_file:   'logs/lead-helper-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      env: { NODE_ENV: 'production' },
    },

    // ─────────────────────────────
    // Агент 2: Morning Digest
    // ─────────────────────────────
    {
      name: 'morning-digest',
      script: 'agents/morning-digest/index.js',
      cwd: '/home/admin/acrogym',
      autorestart: true,
      max_restarts: 5,
      restart_delay: 10000,
      watch: false,
      error_file: 'logs/morning-digest-error.log',
      out_file:   'logs/morning-digest-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      env: { NODE_ENV: 'production', TZ: 'Asia/Qatar' },
    },

    // ─────────────────────────────
    // Шаблон для следующего агента:
    // ─────────────────────────────
    // {
    //   name: 'deduplication',
    //   script: 'agents/deduplication/index.js',
    //   cwd: '/home/admin/acrogym',
    //   autorestart: true,
    //   max_restarts: 10,
    //   restart_delay: 5000,
    //   watch: false,
    //   error_file: 'logs/deduplication-error.log',
    //   out_file:   'logs/deduplication-out.log',
    //   log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    //   env: { NODE_ENV: 'production' },
    // },
  ],
};
