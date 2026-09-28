/**
 * Minimal per-Durable-Object FIFO for operations that share a fragile upstream
 * runtime. Failures do not poison later tasks.
 */
export class SerialTaskQueue {
	private tail: Promise<void> = Promise.resolve();

	run<T>(task: () => Promise<T>): Promise<T> {
		const result = this.tail.then(task);
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}
