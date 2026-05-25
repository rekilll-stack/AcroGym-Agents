'use strict';

const pino = require('pino');
const path = require('path');
const fs = require('fs');

const LOGS_DIR = path.join(__dirname, '../logs');

// Создаём папку logs если не существует
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

/**
 * Создаёт логгер для конкретного агента.
 * Пишет структурированный JSON в файл + pretty-вывод в stdout.
 *
 * @param {string} agentName  - имя агента (lead-helper, etc.)
 * @returns {pino.Logger}
 */
function createLogger(agentName) {
  const logFile = path.join(LOGS_DIR, `${agentName}.log`);
  const level = process.env.LOG_LEVEL || 'info';

  // Ротация по дням — pino пишет в один файл, ротацию делаем через transport
  const transport = pino.transport({
    targets: [
      // JSON в файл
      {
        target: 'pino/file',
        level,
        options: { destination: logFile, mkdir: true },
      },
      // Pretty в stdout
      {
        target: 'pino-pretty',
        level,
        options: {
          colorize: true,
          translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
          ignore: 'pid,hostname',
          messageFormat: `[${agentName}] {msg}`,
        },
      },
    ],
  });

  return pino({ level, name: agentName }, transport);
}

module.exports = { createLogger };
