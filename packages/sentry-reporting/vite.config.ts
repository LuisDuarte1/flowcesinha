import { resolve } from "path";
import { defineConfig } from "vite";

export default defineConfig({
	build: {
		lib: {
			entry: resolve(__dirname, "src/lib.ts"),
			name: "Flowcesinha Sentry Reporting",
			// the proper extensions will be added
			fileName: "flowcesinha-sentry-reporting",
			formats: ["es", "cjs"],
		},
		rollupOptions: {
			external: ["cloudflare:workers"],
		},
	},
});
