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
    // Агент 2: Owner Bot
    // ─────────────────────────────
    {
      name: 'owner-bot',
      script: 'agents/owner-bot/index.js',
      cwd: '/home/admin/acrogym',
      autorestart: true,
      max_restarts: 5,
      restart_delay: 10000,
      watch: false,
      error_file: 'logs/owner-bot-error.log',
      out_file:   'logs/owner-bot-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      env: { NODE_ENV: 'production', TZ: 'Asia/Qatar' },
    },

    // ─────────────────────────────
    // Агент 3: Pre-launch Nurture (следующий)
    // ─────────────────────────────
    // {
    //   name: 'nurture',
    //   script: 'agents/nurture/index.js',
    //   cwd: '/home/admin/acrogym',
    //   autorestart: true,
    //   max_restarts: 10,
    //   restart_delay: 5000,
    //   watch: false,
    //   error_file: 'logs/nurture-error.log',
    //   out_file:   'logs/nurture-out.log',
    //   log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    //   env: { NODE_ENV: 'production' },
    // },
  ],
};
