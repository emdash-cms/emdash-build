import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { d1, r2 } from "@emdash-cms/cloudflare";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, passthroughImageService } from "astro/config";
import emdash from "emdash/astro";

export default defineConfig({
	output: "server",
	adapter: cloudflare(),
	image: {
		// The Cloudflare image binding can terminate local streamed HTML midway
		// through an <Image> render. Generated sites still use EmDash's Image
		// component; local previews serve its resolved media URL without an
		// additional Astro transform.
		service: passthroughImageService(),
		layout: "constrained",
		responsiveStyles: true,
	},
	vite: {
		plugins: [tailwindcss()],
	},
	integrations: [
		// EmDash's admin uses React. Public pages must remain Astro-only.
		react(),
		emdash({
			database: d1({ binding: "DB", session: "auto" }),
			storage: r2({ binding: "MEDIA" }),
		}),
	],
	devToolbar: { enabled: false },
});
