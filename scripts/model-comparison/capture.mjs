// Full-page screenshots of a draft preview. The preview refuses top-level
// document navigations (it only renders inside the Builder's iframe), so the
// browser's document request is answered from a fetch made here as an iframe
// load would be. Everything else (CSS, fonts, images) loads normally, and the
// page renders top-level, so vh units match the emulated viewport.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const CHROME =
	process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export const VIEWPORTS = {
	desktop: { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
	mobile: { width: 390, height: 844, deviceScaleFactor: 1, mobile: true },
};
const MAX_PAGE_HEIGHT = 12_000;
const TILE_SCREENS = 2;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function launchChrome() {
	const profile = mkdtempSync(join(tmpdir(), "capture-chrome-"));
	const child = spawn(
		CHROME,
		[
			"--headless=new",
			"--remote-debugging-port=0",
			`--user-data-dir=${profile}`,
			"--no-first-run",
			"--no-default-browser-check",
			"--hide-scrollbars",
			"--force-color-profile=srgb",
			"about:blank",
		],
		{ stdio: ["ignore", "ignore", "pipe"] },
	);
	const wsUrl = await new Promise((resolve, reject) => {
		let buffer = "";
		const timer = setTimeout(() => reject(new Error("Chrome did not start in 20s.")), 20_000);
		child.stderr.on("data", (chunk) => {
			buffer += chunk;
			const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffer);
			if (match) {
				clearTimeout(timer);
				resolve(match[1]);
			}
		});
		child.once("exit", (code) => reject(new Error(`Chrome exited with ${code}.`)));
	});
	const exited = new Promise((resolve) => child.once("exit", resolve));
	return {
		wsUrl,
		async close() {
			child.kill();
			await exited;
			rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
		},
	};
}

function connect(wsUrl) {
	const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
	let nextId = 0;
	const pending = new Map();
	const listeners = new Set();
	ws.on("message", (data) => {
		const message = JSON.parse(String(data));
		if (message.id === undefined) {
			for (const listener of listeners) listener(message);
			return;
		}
		const waiter = pending.get(message.id);
		pending.delete(message.id);
		if (message.error) waiter?.reject(new Error(`${waiter.method}: ${message.error.message}`));
		else waiter?.resolve(message.result);
	});
	const opened = new Promise((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	return {
		opened,
		send(method, params = {}, sessionId) {
			const id = ++nextId;
			ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
			return new Promise((resolve, reject) => pending.set(id, { resolve, reject, method }));
		},
		on(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		close: () => ws.close(),
	};
}

function waitFor(cdp, sessionId, method, timeoutMs) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			off();
			reject(new Error(`${method} did not arrive in ${timeoutMs}ms.`));
		}, timeoutMs);
		const off = cdp.on((message) => {
			if (message.sessionId !== sessionId || message.method !== method) return;
			clearTimeout(timer);
			off();
			resolve(message.params);
		});
	});
}

const SETTLE = `(async () => {
	const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	for (let y = 0; y < document.documentElement.scrollHeight && y < ${MAX_PAGE_HEIGHT}; y += innerHeight / 2) {
		scrollTo(0, y);
		await pause(120);
	}
	scrollTo(0, 0);
	await document.fonts.ready;
	await Promise.all([...document.images].map((image) => image.complete ? null :
		new Promise((resolve) => { image.addEventListener("load", resolve); image.addEventListener("error", resolve); setTimeout(resolve, 8000); })));
	await pause(1200);
	return true;
})()`;

const MEASURE = `JSON.stringify({
	title: document.title,
	height: document.documentElement.scrollHeight,
	horizontalOverflowPx: Math.max(0, document.documentElement.scrollWidth - innerWidth),
	images: document.images.length,
	brokenImages: [...document.images].filter((image) => image.complete && image.naturalWidth === 0).length,
	textChars: document.body.innerText.trim().length,
})`;

async function capturePage(cdp, url, viewport, filePrefix) {
	const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
	const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
	const send = (method, params) => cdp.send(method, params, sessionId);
	const origin = new URL(url).origin;
	let documentStatus;
	const off = cdp.on(async (message) => {
		if (message.sessionId !== sessionId || message.method !== "Fetch.requestPaused") return;
		const { requestId, request } = message.params;
		try {
			const response = await fetch(request.url, {
				headers: { Accept: "text/html", "Sec-Fetch-Dest": "iframe" },
				redirect: "manual",
				signal: AbortSignal.timeout(30_000),
			});
			documentStatus = response.status;
			const body = Buffer.from(await response.arrayBuffer()).toString("base64");
			const responseHeaders = [...response.headers]
				.filter(([name]) => !/^(content-encoding|content-length|transfer-encoding)$/i.test(name))
				.map(([name, value]) => ({ name, value }));
			await send("Fetch.fulfillRequest", {
				requestId,
				responseCode: response.status,
				responseHeaders,
				body,
			});
		} catch {
			await send("Fetch.failRequest", { requestId, errorReason: "Failed" }).catch(() => {});
		}
	});
	try {
		await send("Fetch.enable", {
			patterns: [{ urlPattern: `${origin}/*`, resourceType: "Document", requestStage: "Request" }],
		});
		await send("Page.enable");
		await send("Emulation.setDeviceMetricsOverride", viewport);
		const loaded = waitFor(cdp, sessionId, "Page.loadEventFired", 45_000);
		await send("Page.navigate", { url });
		await loaded;
		await send("Runtime.evaluate", { expression: SETTLE, awaitPromise: true, timeout: 60_000 });
		const measured = JSON.parse(
			(await send("Runtime.evaluate", { expression: MEASURE, returnByValue: true })).result.value,
		);
		const height = Math.min(measured.height, MAX_PAGE_HEIGHT);
		const shoot = async (y, clipHeight, file) => {
			const shot = await send("Page.captureScreenshot", {
				format: "jpeg",
				quality: 82,
				captureBeyondViewport: true,
				clip: { x: 0, y, width: viewport.width, height: clipHeight, scale: 1 },
			});
			writeFileSync(file, Buffer.from(shot.data, "base64"));
			return file;
		};
		const full = await shoot(0, height, `${filePrefix}.jpg`);
		const tileHeight = viewport.height * TILE_SCREENS;
		const tiles = [];
		for (let y = 0, index = 0; y < height; y += tileHeight, index += 1) {
			tiles.push(
				await shoot(y, Math.min(tileHeight, height - y), `${filePrefix}.tile-${index}.jpg`),
			);
		}
		return { url, documentStatus, ...measured, capturedHeight: height, full, tiles };
	} finally {
		off();
		await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
	}
}

/** Screenshot home and up to `innerPages` linked routes at both viewports (inner pages desktop only). */
export async function captureSite(previewUrl, paths, outDir, { innerPages = 3 } = {}) {
	mkdirSync(outDir, { recursive: true });
	const inner = [...new Set(paths)].filter((path) => path !== "/").slice(0, innerPages);
	const jobs = [
		{ path: "/", viewport: "desktop" },
		{ path: "/", viewport: "mobile" },
		...inner.map((path) => ({ path, viewport: "desktop" })),
	];
	const chrome = await launchChrome();
	const cdp = connect(chrome.wsUrl);
	await cdp.opened;
	const pages = [];
	try {
		for (const [index, job] of jobs.entries()) {
			const url = new URL(job.path, previewUrl).href;
			const prefix = join(outDir, `${String(index).padStart(2, "0")}-${job.viewport}`);
			try {
				pages.push({ ...job, ...(await capturePage(cdp, url, VIEWPORTS[job.viewport], prefix)) });
			} catch (error) {
				pages.push({ ...job, url, error: error instanceof Error ? error.message : String(error) });
			}
			await sleep(200);
		}
	} finally {
		cdp.close();
		await chrome.close();
	}
	return pages;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [previewUrl, outDir, ...paths] = process.argv.slice(2);
	if (!previewUrl || !outDir) {
		console.error(
			"Usage: node scripts/model-comparison/capture.mjs <preview-url> <out-dir> [path...]",
		);
		process.exitCode = 1;
	} else {
		console.log(JSON.stringify(await captureSite(previewUrl, paths, outDir), null, 2));
	}
}
