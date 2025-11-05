module.exports = {
	apps: [
		{
			name: "hyperpocket-backend",
			script: "dist/src/index.js",
			instances: 1,
			max_memory_restart: "2G",
			out_file: "./logs/output.log",
			error_file: "./logs/error.log",
			log_date_format: "YYYY-MM-DD HH:mm:ss",
			merge_logs: true,
		},
	],
};
