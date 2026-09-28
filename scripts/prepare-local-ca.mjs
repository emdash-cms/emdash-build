import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function prepareLocalCa({
	source = process.env.SSL_CERT_FILE ?? process.env.NIX_SSL_CERT_FILE,
	targetDirectory = resolve(".dev-ca"),
} = {}) {
	await mkdir(targetDirectory, { recursive: true });
	const target = resolve(targetDirectory, "host-ca.pem");
	await rm(target, { force: true });
	if (!source) return { copied: false, target };

	try {
		const details = await stat(source);
		if (!details.isFile() || details.size === 0) return { copied: false, target };
		await copyFile(source, target);
		return { copied: true, target };
	} catch {
		return { copied: false, target };
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const result = await prepareLocalCa();
	if (result.copied) console.log("Prepared the local TLS trust bundle for Sandbox.");
}
