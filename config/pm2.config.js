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
    // Watchdog: heartbeat-based liveness monitor
    // ─────────────────────────────
    {
      name: 'watchdog',
      script: 'agents/watchdog/index.js',
      cwd: '/home/admin/acrogym',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      watch: false,
      error_file: 'logs/watchdog-error.log',
      out_file:   'logs/watchdog-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      // PM2-spawned children don't inherit the user's PATH, so `pm2` isn't
      // resolvable by name — point the watchdog at the absolute binary.
      env: {
        NODE_ENV: 'production',
        TZ: 'Asia/Qatar',
        PM2_BIN: '/home/admin/.npm-global/bin/pm2',
      },
    },

    // ─────────────────────────────
    // Агент 4: Content bot (Instagram drafts — separate bot, own token)
    // ─────────────────────────────
    {
      name: 'content-bot',
      script: 'agents/content-bot/index.js',
      cwd: '/home/admin/acrogym',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      watch: false,
      error_file: 'logs/content-bot-error.log',
      out_file:   'logs/content-bot-out.log',
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
