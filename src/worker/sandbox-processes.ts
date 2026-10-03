/**
 * Background processes for the SDK 1.0 container, which runs commands but
 * keeps no process table: each process gets a directory holding its pid, its
 * combined output and, once it exits, its exit code. The scripts take the
 * directory as their first argument and are run with `bash -c SCRIPT name dir`.
 */

/** Where process directories live; `/tmp` is the container's own and starts empty. */
export const PROCESS_ROOT = "/tmp/emdash-build/processes";

/** Process ids become directory names. */
export function processDir(id: string, root = PROCESS_ROOT): string {
	if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error(`Invalid process id: ${id}`);
	return `${root}/${id}`;
}

/**
 * Start `"$@"` (after the directory) in its own session, so stopping it can
 * signal the whole process group, and record its exit code when it ends. The
 * runner records its own pid first and stays until then; the caller does not
 * wait for it. Exits 97 when a process that has not exited holds the id; an
 * exited one's directory is replaced.
 */
export const RUN_PROCESS = [
	'dir=$1; shift; mkdir -p "$(dirname "$dir")" || exit 97',
	'if [ -f "$dir/exit-code" ]; then rm -rf "$dir"; fi',
	'mkdir "$dir" || exit 97',
	'echo "$$" > "$dir/runner"',
	': > "$dir/output.log"',
	// -w: when setsid has to fork, it still waits, so the exit code below is the process's.
	'setsid -w sh -c \'echo "$$" > "$0/pid.tmp" && mv "$0/pid.tmp" "$0/pid" && exec "$@"\' "$dir" "$@" >> "$dir/output.log" 2>&1 < /dev/null',
	'echo "$?" > "$dir/exit-code.tmp" && mv "$dir/exit-code.tmp" "$dir/exit-code"',
].join("\n");

/** Shell functions the other scripts share; `$dir` is the process directory. */
const PROCESS_HELPERS = [
	'exited() { [ -f "$dir/exit-code" ] && echo "exited $(cat "$dir/exit-code")"; }',
	'alive() { [ -f "$dir/$1" ] && kill -0 "$(cat "$dir/$1")" 2>/dev/null; }',
].join("\n");

/**
 * Print the process state: `exited <code>`, `running <pid>`, `starting` (no
 * pid yet) or `missing`. Once the process is gone its runner records the exit
 * code, so that is waited for while the runner lives; a runner that is gone
 * too was killed with the process, which reports `exited 137`.
 */
export const PROCESS_STATUS = [
	"dir=$1",
	PROCESS_HELPERS,
	"exited && exit 0",
	'[ -d "$dir" ] || { echo missing; exit 0; }',
	'if alive pid; then echo "running $(cat "$dir/pid")"; exit 0; fi',
	'[ -f "$dir/runner" ] || { echo starting; exit 0; }',
	"i=0",
	'while alive runner && [ "$i" -lt 100 ]; do',
	'  [ -f "$dir/pid" ] || { echo starting; exit 0; }',
	"  exited && exit 0",
	"  sleep 0.05; i=$((i + 1))",
	"done",
	'exited || echo "exited 137"',
].join("\n");

/**
 * Stream the process output from the start, following it until the process
 * can write no more: its exit code is recorded, or its runner is gone too.
 * Polls the file, which needs neither GNU tail nor inotify.
 */
export const FOLLOW_PROCESS = [
	"dir=$1; offset=0; waited=0",
	PROCESS_HELPERS,
	"flush() {",
	'  size=$(wc -c < "$dir/output.log" 2>/dev/null | tr -d " ") || return 0',
	'  if [ -n "$size" ] && [ "$size" -gt "$offset" ]; then',
	'    tail -c +"$((offset + 1))" "$dir/output.log" | head -c "$((size - offset))"',
	"    offset=$size",
	"  fi",
	"}",
	"finished() {",
	'  [ -f "$dir/exit-code" ] || [ ! -d "$dir" ] && return 0',
	// The runner records its pid at once; one that never did is not coming.
	'  if [ ! -f "$dir/runner" ]; then waited=$((waited + 1)); [ "$waited" -gt 40 ]; return; fi',
	"  ! alive runner",
	"}",
	"while :; do",
	"  if finished; then flush; exit 0; fi",
	"  flush",
	"  sleep 0.25",
	"done",
].join("\n");

/**
 * Stop the process group: SIGTERM, then SIGKILL after `$2` seconds. A process
 * still starting gets a moment to record its pid. The group can outlive a
 * leader that exits first, and its id is not reused while any member lives,
 * so the group is what is signalled and waited for. Stopping a process that
 * already ended, or never started, succeeds.
 */
export const STOP_PROCESS = [
	"dir=$1; grace=${2:-5}",
	"i=0",
	'while [ ! -f "$dir/pid" ] && [ ! -f "$dir/exit-code" ] && [ -d "$dir" ] && [ "$i" -lt 30 ]; do',
	"  sleep 0.1; i=$((i + 1))",
	"done",
	'[ -f "$dir/pid" ] || exit 0',
	'pid=$(cat "$dir/pid")',
	'group() { kill -0 -- "-$pid" 2>/dev/null; }',
	"group || exit 0",
	'kill -TERM -- "-$pid" 2>/dev/null',
	'i=0; while [ "$i" -lt "$((grace * 10))" ]; do group || exit 0; sleep 0.1; i=$((i + 1)); done',
	'kill -KILL -- "-$pid" 2>/dev/null',
	"exit 0",
].join("\n");

export type ProcessState =
	| { state: "running"; pid: number }
	| { state: "starting" }
	| { state: "exited"; exitCode: number }
	| { state: "missing" };

export function parseProcessState(output: string): ProcessState {
	const [state, value] = output.trim().split(/\s+/);
	if (state === "running" && Number.isSafeInteger(Number(value))) {
		return { state, pid: Number(value) };
	}
	if (state === "exited" && Number.isSafeInteger(Number(value))) {
		return { state, exitCode: Number(value) };
	}
	if (state === "starting") return { state };
	return { state: "missing" };
}

/**
 * Turn raw process output into the 0.12 SDK's log events, one per line:
 * `data: {"type":"stdout","data":"line\n"}`, then `data: {"type":"complete","exitCode":N}`.
 */
export function processLogEvents(
	output: ReadableStream<Uint8Array>,
	exitCode: () => Promise<number>,
	onCancel?: () => void,
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	const reader = output.getReader();
	let pending = "";
	const event = (value: object) => encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				// A pull that enqueues nothing is not called again, so read until a line is complete.
				for (;;) {
					const { done, value } = await reader.read();
					if (done) {
						const rest = pending + decoder.decode();
						if (rest) controller.enqueue(event({ type: "stdout", data: rest }));
						controller.enqueue(event({ type: "complete", exitCode: await exitCode() }));
						controller.close();
						return;
					}
					pending += decoder.decode(value, { stream: true });
					const lines = pending.split("\n");
					pending = lines.pop() ?? "";
					for (const line of lines) {
						controller.enqueue(event({ type: "stdout", data: `${line}\n` }));
					}
					if (lines.length > 0) return;
				}
			} catch (error) {
				controller.error(error);
			}
		},
		async cancel(reason) {
			onCancel?.();
			await reader.cancel(reason).catch(() => {});
		},
	});
}
