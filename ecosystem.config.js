// ecosystem.config.js
module.exports = {
  apps: [
    {
      name: "katafree",
      script: "server.js",
      instances: "max",
      exec_mode: "cluster",
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};