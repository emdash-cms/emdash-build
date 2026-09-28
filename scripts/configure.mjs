import { writeFile } from "node:fs/promises";
import { loadProviderConfig, renderStudioWrangler } from "./provider-config.mjs";

const input = process.env.EMDASH_PROVIDER_CONFIG ?? "provider.config.json";
const output = process.env.EMDASH_PROVIDER_OUTPUT ?? "wrangler.provider.jsonc";
const config = await loadProviderConfig(input);
await writeFile(output, `${JSON.stringify(renderStudioWrangler(config), null, "\t")}\n`, "utf8");
console.log(`configure: wrote ${output} for ${config.providerId}`);
