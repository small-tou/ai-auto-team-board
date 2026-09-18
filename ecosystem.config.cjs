/**
 * pm2 部署配置。
 *
 *   pm2 start ecosystem.config.cjs   首次启动
 *   pm2 reload autoboard             改代码后热重启
 *   pm2 save                         写入开机自启列表
 *
 * 注意 exec_mode 必须是 fork 且 instances = 1：
 * store.mjs 的事件日志是「单写入者追加写」，cluster 多实例会并发写同一个 events.jsonl。
 */
module.exports = {
  apps: [
    {
      name: 'autoboard',
      script: 'src/server.mjs',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_memory_restart: '200M',
      env: {
        // 公网机器只绑回环，对外走 nginx 80
        BOARD_HOST: '127.0.0.1',
        BOARD_PORT: '7788',
      },
    },
  ],
};
