/**
 * PM2: server + 5 session (cùng session.js, tách bằng ACCOUNT_INDEX)
 * Chạy: pm2 start ecosystem.config.sessions.js
 *
 * Nhẹ mặc định: HEADLESS=1, BLOCK_MEDIA=on, HEARTBEAT 15s, viewport 1280x720
 * Tài khoản NS2..NS5: set USERNAME_ACCOUNT_2..5 / PASSWORD_ACCOUNT_2..5 trong .env
 */
const path = require("path");

const sharedEnv = {
  HEADLESS: "1",
  USE_FIREFOX: "1",
  BLOCK_MEDIA: "1",
  HEARTBEAT_MS: "15000",
  VIEWPORT_W: "1280",
  VIEWPORT_H: "720",
};

function sessionApp(index) {
  return {
    name: `session_sexy_${index}`,
    script: "./servicePuppeteer/session.js",
    cwd: __dirname,
    node_args: "--max-old-space-size=512",
    interpreter_args: "-r dotenv/config",
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
    watch: false,
    min_uptime: "60s",
    max_restarts: 12,
    restart_delay: 12000,
    kill_timeout: 10000,
    max_memory_restart: "700M",
    env: {
      ...sharedEnv,
      ACCOUNT_INDEX: String(index),
      DOTENV_CONFIG_PATH: path.join(__dirname, ".env"),
    },
  };
}

module.exports = {
  apps: [
    {
      name: "server_sexy",
      script: "./server.js",
      cwd: __dirname,
      node_args: "--max-old-space-size=768",
      interpreter_args: "-r dotenv/config",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      min_uptime: "30s",
      max_restarts: 15,
      restart_delay: 8000,
      max_memory_restart: "900M",
      env: {
        DOTENV_CONFIG_PATH: path.join(__dirname, ".env"),
        SERVER_VERBOSE_LOG: "false",
      },
    },
    sessionApp(1),
    sessionApp(2),
    sessionApp(3),
    sessionApp(4),
    sessionApp(5),
  ],
};
