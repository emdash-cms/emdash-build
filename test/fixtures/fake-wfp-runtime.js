const scripts = new Map();
const calls = [];
const failHealth = new Set();
const failHealthOnce = new Set();
const ambiguousOnce = new Set();
const rejectUpload = new Set();
const rejectDefinitely = new Set();
const retryableThenRejected = new Map();

export default {
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/reset") {
			scripts.clear();
			calls.length = 0;
			failHealth.clear();
			failHealthOnce.clear();
			ambiguousOnce.clear();
			rejectUpload.clear();
			rejectDefinitely.clear();
			retryableThenRejected.clear();
			return Response.json({ ok: true });
		}
		if (url.pathname === "/configure") {
			const body = await request.json();
			failHealth.clear();
			for (const id of body.failHealth ?? []) failHealth.add(id);
			failHealthOnce.clear();
			for (const id of body.failHealthOnce ?? []) failHealthOnce.add(id);
			ambiguousOnce.clear();
			for (const name of body.ambiguousOnce ?? []) ambiguousOnce.add(name);
			rejectUpload.clear();
			for (const name of body.rejectUpload ?? []) rejectUpload.add(name);
			rejectDefinitely.clear();
			for (const name of body.rejectDefinitely ?? []) rejectDefinitely.add(name);
			retryableThenRejected.clear();
			for (const name of body.retryableThenRejected ?? []) retryableThenRejected.set(name, 503);
			return Response.json({ ok: true });
		}
		if (url.pathname === "/upload") {
			const body = await request.json();
			calls.push({ kind: "upload", ...body });
			const sequencedStatus = retryableThenRejected.get(body.scriptName);
			if (sequencedStatus === 503) {
				scripts.set(body.scriptName, {
					releaseId: body.releaseId,
					uploadDigest: body.uploadDigest,
				});
				retryableThenRejected.set(body.scriptName, 403);
				return Response.json({ code: "RETRYABLE" }, { status: 503 });
			}
			if (sequencedStatus === 403) {
				retryableThenRejected.delete(body.scriptName);
				return Response.json({ code: "REJECTED" }, { status: 403 });
			}
			if (rejectUpload.has(body.scriptName)) {
				return Response.json({ code: "RETRYABLE" }, { status: 503 });
			}
			if (rejectDefinitely.has(body.scriptName)) {
				return Response.json({ code: "REJECTED" }, { status: 403 });
			}
			scripts.set(body.scriptName, {
				releaseId: body.releaseId,
				uploadDigest: body.uploadDigest,
			});
			if (ambiguousOnce.delete(body.scriptName)) {
				return Response.json({ code: "AMBIGUOUS" }, { status: 599 });
			}
			return Response.json({ ok: true });
		}
		if (url.pathname === "/identity") {
			const identity = scripts.get(url.searchParams.get("script"));
			return identity ? Response.json(identity) : new Response(null, { status: 404 });
		}
		if (url.pathname === "/delete") {
			const body = await request.json();
			calls.push({ kind: "delete", scriptName: body.scriptName });
			scripts.delete(body.scriptName);
			return Response.json({ ok: true });
		}
		if (url.pathname === "/health") {
			const identity = scripts.get(url.searchParams.get("script"));
			if (identity && failHealthOnce.delete(identity.releaseId)) {
				return new Response("not ready", { status: 503 });
			}
			return identity && !failHealth.has(identity.releaseId)
				? new Response("ok")
				: new Response("failed", { status: 500 });
		}
		if (url.pathname === "/state") {
			return Response.json({ scripts: Object.fromEntries(scripts), calls });
		}
		return new Response("Not found", { status: 404 });
	},
};
