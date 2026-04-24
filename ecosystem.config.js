module.exports = {
  apps: [
    {
      name: "api",
      script: "./src/server.js",
      env: {
        NODE_ENV: "production"
      },
      error_file: "./logs/error.log",
      out_file: "./logs/out.log",
      time: true,
      merge_logs: true
    }
  ]
};
