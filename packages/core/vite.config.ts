import { resolve } from "path";
import { defineConfig } from "vite";

export default defineConfig({
	build: {
		lib: {
			entry: resolve(__dirname, "src/lib.ts"),
			name: "Flowcesinha",
			// the proper extensions will be added
			fileName: "flowcesinha",
			formats: ["es", "cjs"],
		},
		rollupOptions: {
			external: ["cloudflare:workers"],
		},
	},
});
