import { resolve } from "path";
import { defineConfig } from "vite";
import dts from "vite-plugin-dts";

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
	plugins: [
		dts({
			outDir: resolve(__dirname, "dist"),
			insertTypesEntry: true,
		}),
	],
});
