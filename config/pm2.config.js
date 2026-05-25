'use strict';

/**
 * PM2 ecosystem config для AcroGym Agents.
 * Чтобы добавить нового агента — добавь объект в массив apps.
 *
 * Запуск:  pm2 start config/pm2.config.js
 * Логи:    pm2 logs lead-helper
 * Монит:   pm2 monit
 */
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
      env: {
        NODE_ENV: 'production',
      },
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
