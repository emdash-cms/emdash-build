/**
 * Staging for session snapshots. Git must never scan the live Vite/SQLite
 * tree, so each checkpoint copies the site to a stable directory first.
 */

/**
 * Top-level site entries that restore rebuilds (dependencies, build output,
 * generated types) plus the site's own git metadata; the snapshot initialises
 * its own. `.gitignore` would drop the first three at `git add`, but only
 * after the staging copy had already paid for them.
 */
const UNSTAGED_SITE_ENTRIES = ["node_modules", "dist", ".astro", ".git"];
const PUBLISH_DISK_RESERVE_KIB = 1024 * 1024;

interface FinishedTurn {
	kind: string;
	resumed: boolean;
	tools: Record<string, { calls: number; failures: number }>;
}

export function canReuseFinalSnapshotForTurn(record: FinishedTurn | undefined): boolean {
	return Boolean(
		record?.kind === "follow-up" &&
		!record.resumed &&
		(record.tools.exec?.calls ?? 0) === 0 &&
		Object.values(record.tools).every((tool) => tool.failures === 0),
	);
}

export function canSkipFinalSnapshot(
	previousGeneration: number | undefined,
	currentGeneration: number | undefined,
	hasPersistenceError: boolean,
): boolean {
	return (
		!hasPersistenceError &&
		previousGeneration !== undefined &&
		currentGeneration !== undefined &&
		previousGeneration === currentGeneration
	);
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Copy the live site into a stable staging tree git can read safely. SQLite
 * databases are backed up through SQLite itself so committed WAL data is
 * included without racing Miniflare's short-lived sidecar files.
 */
export function snapshotStagingCommand(sitePath: string, snapshotPath: string): string {
	const tarExcludes = [
		...UNSTAGED_SITE_ENTRIES.map((name) => `--exclude=${shellQuote(`./${name}`)}`),
		"--exclude='*.sqlite'",
		"--exclude='*.sqlite-wal'",
		"--exclude='*.sqlite-shm'",
	].join(" ");
	const sourceRoot = `${sitePath}/`;
	const destinationRoot = `${snapshotPath}/`;
	const copyFiles = `tar -C "$1" ${tarExcludes} -cf - . | tar -C "$2" -xf -`;
	const sqlitePrunes = [
		...UNSTAGED_SITE_ENTRIES.map((name) => `${sitePath}/${name}`),
		`${sitePath}/.wrangler/state/v3/observability`,
	]
		.map((path) => `-path ${shellQuote(path)}`)
		.join(" -o ");
	return (
		`rm -rf ${shellQuote(snapshotPath)} && mkdir -p ${shellQuote(snapshotPath)} && ` +
		`bash -o pipefail -c ${shellQuote(copyFiles)} sh ` +
		`${shellQuote(sitePath)} ${shellQuote(snapshotPath)} && ` +
		`find ${shellQuote(sitePath)} \\( ${sqlitePrunes} \\) -prune -o ` +
		`-type f -name '*.sqlite' ` +
		`-exec sh -c 'source_root="$1"; destination_root="$2"; shift 2; ` +
		`for source do relative="\${source#"$source_root"}"; destination="\${destination_root}\${relative}"; ` +
		`mkdir -p "$(dirname "$destination")"; ` +
		`sqlite3 -readonly "$source" ".backup \"$destination\"" || exit 1; done' sh ` +
		`${shellQuote(sourceRoot)} ${shellQuote(destinationRoot)} {} + && ` +
		`rm -rf ${shellQuote(`${snapshotPath}/.wrangler/state/v3/observability`)}`
	);
}

/** Copy a frozen checkpoint and its installed dependencies into an isolated tree. */
export function publishStagingCommand(
	checkpointPath: string,
	sitePath: string,
	publishPath: string,
): string {
	return (
		`rm -rf ${shellQuote(publishPath)} && ` +
		`checkpoint_kib=$(du -sk ${shellQuote(checkpointPath)} | awk 'NR == 1 { print $1 }') && ` +
		`dependencies_kib=$(du -sk ${shellQuote(`${sitePath}/node_modules`)} | awk 'NR == 1 { print $1 }') && ` +
		`available_kib=$(df -Pk ${shellQuote(checkpointPath)} | awk 'END { print $4 }') && ` +
		`required_kib=$((checkpoint_kib + dependencies_kib + ${PUBLISH_DISK_RESERVE_KIB})) && ` +
		`if [ "$available_kib" -lt "$required_kib" ]; then ` +
		`echo 'Publish staging needs more free disk space.' >&2; exit 1; fi && ` +
		snapshotStagingCommand(checkpointPath, publishPath) +
		` && test -d ${shellQuote(`${sitePath}/node_modules`)} && ` +
		`mkdir ${shellQuote(`${publishPath}/node_modules`)} && ` +
		`find ${shellQuote(`${sitePath}/node_modules`)} -mindepth 1 -maxdepth 1 ` +
		`! -name '.astro' ! -name '.vite' ` +
		`-exec sh -c 'dest="$1"; shift; cp -a "$@" "$dest"/' sh ` +
		`${shellQuote(`${publishPath}/node_modules`)} {} +`
	);
}

/** Snapshot git metadata, beside the staging copy so it survives each rebuild of it. */
export const SNAPSHOT_GIT_DIR = "/tmp/emdash-build-session-git";

/**
 * Commit the staged tree as a new root commit, in a git directory kept beside
 * the staging copy so it survives each rebuild of that copy. The remote still
 * holds one snapshot commit, but the previous snapshot's objects stay local,
 * so the next push sends only what changed. Prints the new commit id.
 *
 * It runs in a subshell: the sandbox's default session keeps exported
 * variables and the working directory for later commands. The index is
 * rebuilt each time, so a lock left by a killed commit cannot wedge later
 * ones and the site's .gitignore applies afresh (every file is rehashed after
 * the staging rebuild anyway).
 */
export function snapshotCommitCommand(options: {
	snapshotPath: string;
	gitDir: string;
	message: string;
	name: string;
	email: string;
}): string {
	const steps = [
		`export GIT_DIR=${shellQuote(options.gitDir)} GIT_WORK_TREE=${shellQuote(options.snapshotPath)}`,
		`cd ${shellQuote(options.snapshotPath)}`,
		'{ test -f "$GIT_DIR/HEAD" || git init -q; }',
		// Only the locks a killed commit leaves; an upload beside it holds pushed.lock.
		'rm -f "$GIT_DIR/index" "$GIT_DIR/index.lock" "$GIT_DIR/refs/heads/snapshot.lock"',
		`git config user.email ${shellQuote(options.email)}`,
		`git config user.name ${shellQuote(options.name)}`,
		// A background gc would stall a checkpoint; old snapshots are pruned after uploads.
		"git config gc.auto 0",
		"git config core.logAllRefUpdates false",
		"git add -A",
		"tree=$(git write-tree)",
		`commit=$(git commit-tree "$tree" -m ${shellQuote(options.message)})`,
		'git update-ref refs/heads/snapshot "$commit"',
		'echo "$commit"',
	];
	return `( ${steps.join(" && ")} )`;
}

/**
 * Push the latest committed snapshot over the remote's main branch and print
 * the pushed commit. It needs no work tree, so it runs from the git directory
 * while the next checkpoint rebuilds the staging copy. The pushed commit stays
 * local, which keeps the next push incremental; older snapshots are pruned.
 * `--no-thin` keeps each pack self-contained. The Sandbox RPC timeout does not
 * kill a stalled git child, so the push is bounded inside the container.
 */
export function snapshotPushCommand(options: {
	gitDir: string;
	remote: string;
	timeoutSeconds: number;
}): string {
	const steps = [
		`export GIT_DIR=${shellQuote(options.gitDir)}`,
		'cd "$GIT_DIR"',
		"commit=$(git rev-parse refs/heads/snapshot)",
		`timeout --signal=TERM --kill-after=2s ${options.timeoutSeconds}s git push -q --no-thin ${shellQuote(options.remote)} "$commit:refs/heads/main" --force`,
		'git update-ref refs/heads/pushed "$commit"',
		// Objects younger than an hour may belong to a commit still being written.
		"{ git prune --expire=1.hour.ago >/dev/null 2>&1 || true; }",
		'echo "$commit"',
	];
	return `( ${steps.join(" && ")} )`;
}
