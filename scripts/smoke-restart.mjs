const baseUrl = new URL(process.env.EMDASH_SMOKE_URL ?? "http://localhost:5173");
if (baseUrl.hostname !== "localhost" && baseUrl.hostname !== "127.0.0.1") {
	throw new Error("Restart validation is intentionally localhost-only.");
}

const sessionResponse = await fetch(new URL("/api/project-session", baseUrl), {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: "{}",
});
if (!sessionResponse.ok) throw new Error(`Project session failed: ${sessionResponse.status}`);
const session = await sessionResponse.json();
const cookie = sessionResponse.headers.get("set-cookie")?.split(";", 1)[0];
if (!cookie || typeof session.projectId !== "string")
	throw new Error("Project session was incomplete.");

async function post(path, body, timeoutMs = 60_000) {
	const startedAt = Date.now();
	const response = await fetch(new URL(path, baseUrl), {
		method: "POST",
		headers: { Cookie: cookie, "Content-Type": "application/json" },
		body: JSON.stringify(body ?? {}),
		signal: AbortSignal.timeout(timeoutMs),
	});
	const result = await response.json();
	if (!response.ok)
		throw new Error(`${path} failed (${response.status}): ${JSON.stringify(result)}`);
	return { result, elapsedMs: Date.now() - startedAt };
}

const provision = await post(
	`/api/projects/${session.projectId}/validation/provision`,
	{},
	120_000,
);
const previewUrl = provision.result.previewUrl;
if (typeof previewUrl !== "string") throw new Error("Provisioning returned no preview URL.");

// Preview authorization survives restarts, but forwarding is runtime-scoped.
// Exercise the sidebar-resume path by revoking it, then requiring recovery to
// reactivate the exact same URL without touching the site directory.
await post(`/api/projects/${session.projectId}/validation/deactivate-preview`);
const inactivePreview = await fetch(previewUrl, { signal: AbortSignal.timeout(30_000) });
if (inactivePreview.ok) throw new Error("Deactivated preview unexpectedly remained reachable.");
const resume = await post(
	`/api/projects/${session.projectId}/validation/resume-preview`,
	undefined,
	120_000,
);
if (resume.result.previewUrl !== previewUrl) {
	throw new Error("Preview recovery changed the stable URL.");
}
const resumedPreview = await fetch(previewUrl, { signal: AbortSignal.timeout(30_000) });
if (!resumedPreview.ok) {
	throw new Error(`Preview failed after resume: ${resumedPreview.status}`);
}

const restarts = [];
for (let attempt = 1; attempt <= 2; attempt++) {
	const restart = await post(`/api/projects/${session.projectId}/validation/restart`);
	const preview = await fetch(previewUrl, { signal: AbortSignal.timeout(30_000) });
	if (!preview.ok) throw new Error(`Preview failed after restart ${attempt}: ${preview.status}`);
	restarts.push({ attempt, elapsedMs: restart.elapsedMs, previewStatus: preview.status });
}

const captures = [];
for (let attempt = 1; attempt <= 2; attempt++) {
	const capture = await post(
		`/api/projects/${session.projectId}/validation/capture`,
		undefined,
		120_000,
	);
	if (capture.result.success !== true || !(capture.result.bytes > 0)) {
		throw new Error(`Preview capture ${attempt} returned no image.`);
	}
	captures.push({ attempt, elapsedMs: capture.elapsedMs, bytes: capture.result.bytes });
}

console.log(
	JSON.stringify(
		{
			ok: true,
			projectId: session.projectId,
			previewUrl,
			provisionElapsedMs: provision.elapsedMs,
			resume: {
				elapsedMs: resume.elapsedMs,
				previewStatus: resumedPreview.status,
			},
			restarts,
			captures,
		},
		null,
		2,
	),
);
