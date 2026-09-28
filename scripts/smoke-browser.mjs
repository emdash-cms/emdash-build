import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
export function browserResult(output) {
	const data = output.data;
	return data && typeof data === "object" && Object.hasOwn(data, "result") ? data.result : data;
}

async function browserCommand(session, args) {
	let stdout;
	try {
		({ stdout } = await exec("agent-browser", ["--session", session, "--json", ...args], {
			timeout: 25_000,
			maxBuffer: 1024 * 1024,
		}));
	} catch (error) {
		const detail = error instanceof Error && "stderr" in error ? String(error.stderr).trim() : "";
		throw new Error(detail.slice(0, 400) || `Browser command ${args[0]} failed.`);
	}
	const output = JSON.parse(stdout);
	if (!output.success)
		throw new Error(output.error?.message ?? String(output.error ?? "Browser failed"));
	return browserResult(output);
}

export function builderOriginForPreview(previewUrl, builderOrigin) {
	if (builderOrigin) return new URL(builderOrigin).origin;
	const preview = new URL(previewUrl);
	const labels = preview.hostname.split(".");
	if (labels.length < 2 || !/^\d{4,5}-/.test(labels[0] ?? "")) {
		throw new Error("Preview URL does not identify its Builder origin.");
	}
	const hostname = labels.slice(1).join(".");
	return `${preview.protocol}//${hostname}${preview.port ? `:${preview.port}` : ""}`;
}

function mainSnapshotText(snapshot) {
	const lines = snapshot.split("\n");
	const mainIndex = lines.findIndex((line) => /^\s*- main(?:\s|$)/.test(line));
	if (mainIndex < 0) return "";
	const mainIndent = lines[mainIndex].match(/^\s*/)?.[0].length ?? 0;
	const names = [];
	for (const line of lines.slice(mainIndex + 1)) {
		const indent = line.match(/^\s*/)?.[0].length ?? 0;
		if (line.trim() && indent <= mainIndent) break;
		const name = line.match(/"((?:\\.|[^"\\])*)"/)?.[1];
		if (name) names.push(name.replaceAll('\\"', '"'));
	}
	return names.join(" ").slice(0, 200);
}

export function previewPageFromSnapshot(data, bridgeState) {
	const refs = Object.values(data?.refs ?? {});
	const heading = refs.find((ref) => ref?.role === "heading" && ref.name)?.name ?? "";
	const snapshot = data?.snapshot ?? "";
	const mainText = mainSnapshotText(snapshot);
	return {
		title: bridgeState?.title ?? "",
		heading,
		mainText,
		links: bridgeState?.links?.length ?? refs.filter((ref) => ref?.role === "link").length,
	};
}

export async function auditFreshBrowser(previewUrl, checkedPaths = ["/"], builderOrigin) {
	const session = `emdash-smoke-${crypto.randomUUID()}`;
	const paths = [...new Set(["/", ...checkedPaths])].slice(0, 3);
	const pages = [];
	try {
		// Draft previews intentionally reject top-level browser navigation. Load
		// them inside the Builder origin, matching the real iframe user journey.
		await browserCommand(session, [
			"open",
			new URL("/api/health", builderOriginForPreview(previewUrl, builderOrigin)).href,
		]);
		for (const path of paths) {
			const source = new URL(path, previewUrl).href;
			const previewOrigin = new URL(source).origin;
			const injectFrame = `(() => {
				document.documentElement.innerHTML = '<head><title>Preview audit</title></head><body></body>';
				window.__emdashPreviewState = null;
				const frame = document.createElement('iframe');
				frame.id = 'emdash-smoke-preview';
				frame.src = ${JSON.stringify(source)};
				frame.style.cssText = 'width:1280px;height:900px;border:0';
				const receivePreviewState = event => {
					if (event.origin !== ${JSON.stringify(previewOrigin)} ||
						event.source !== frame.contentWindow ||
						event.data?.source !== 'emdash-preview' ||
						event.data.type !== 'state' ||
						!Array.isArray(event.data.links)) return;
					window.__emdashPreviewState = event.data;
					window.removeEventListener('message', receivePreviewState);
				};
				window.addEventListener('message', receivePreviewState);
				document.body.appendChild(frame);
				return true;
			})()`;
			await browserCommand(session, ["eval", injectFrame]);
			await browserCommand(session, ["wait", "#emdash-smoke-preview"]);
			let page;
			let bridgeConfirmed = false;
			for (let attempt = 0; attempt < 30; attempt++) {
				const snapshot = await browserCommand(session, ["snapshot"]);
				const bridgeState = await browserCommand(session, ["eval", "window.__emdashPreviewState"]);
				bridgeConfirmed = bridgeState !== null && bridgeState !== undefined;
				page = previewPageFromSnapshot(snapshot, bridgeState);
				if (bridgeConfirmed && page.heading && page.mainText) break;
				await browserCommand(session, ["wait", "500"]);
			}
			if (!bridgeConfirmed || !page?.heading || !page.mainText) {
				return {
					success: false,
					pages,
					error: `Fresh browser did not render visible site content on ${path}.`,
				};
			}
			pages.push({ path, title: page.title, heading: page.heading, links: page.links });
		}
		return { success: true, pages };
	} catch (error) {
		return {
			success: false,
			pages,
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		await browserCommand(session, ["close"]).catch(() => undefined);
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const previewUrl = process.argv[2];
	if (!previewUrl) {
		console.error("Usage: node scripts/smoke-browser.mjs <preview-url> [route...]");
		process.exitCode = 1;
	} else {
		const result = await auditFreshBrowser(previewUrl, process.argv.slice(3));
		console.log(JSON.stringify(result, null, 2));
		if (!result.success) process.exitCode = 1;
	}
}
