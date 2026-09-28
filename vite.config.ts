import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * Keep the dev server alive through host-side unhandled rejections.
 *
 * `@cloudflare/vite-plugin`'s local container/tunnel proxy can throw an
 * unhandled promise rejection -- `response.json()` on a non-JSON body (an SSE
 * stream or WebSocket frame proxied back from the sandbox preview) surfaces in
 * Node/undici, and Node's default is to crash the whole process. That kills the
 * dev server mid-session. This is dev-only (production runs in workerd, which
 * doesn't hard-crash on unhandled rejections) and a workaround for an upstream
 * bug, not a fix: log loudly and keep serving. Remove once the plugin guards
 * its own proxy body parsing.
 */
let devRejectionGuardInstalled = false;
function devKeepAlive(): Plugin {
	return {
		name: "emdash-dev-keepalive",
		apply: "serve",
		configureServer() {
			if (devRejectionGuardInstalled) return;
			devRejectionGuardInstalled = true;
			process.on("unhandledRejection", (reason) => {
				// Swallow ONLY the known class -- a JSON parse failure from the
				// container proxy reading a non-JSON (SSE/WebSocket/binary) body.
				// Re-throw anything else so real bugs still surface (and crash).
				const msg = reason instanceof Error ? reason.message : String(reason);
				if (reason instanceof SyntaxError && /JSON|Unexpected token/i.test(msg)) {
					console.error(
						`[dev-keepalive] Suppressed container-proxy JSON parse rejection to keep the dev server alive: ${msg}`,
					);
					return;
				}
				throw reason;
			});
		},
	};
}

export default defineConfig({
	plugins: [
		react(),
		tailwindcss(),
		cloudflare({
			...(process.env.EMDASH_WRANGLER_CONFIG
				? { configPath: process.env.EMDASH_WRANGLER_CONFIG }
				: {}),
			...(process.env.EMDASH_UI_ONLY === "1"
				? { config: { dev: { enable_containers: false } } }
				: {}),
		}),
		devKeepAlive(),
	],
});
