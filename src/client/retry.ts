const DEFAULT_RETRY_DELAYS = [100, 250] as const;

export function isTransientResponse(response: Response): boolean {
	return response.status >= 500 || response.status === 408 || response.status === 429;
}

/** Retry a short client operation twice; callers decide which successful results remain transient. */
export async function retryTransient<T>(
	operation: () => Promise<T>,
	shouldRetryResult: (result: T) => boolean,
	delays: readonly number[] = DEFAULT_RETRY_DELAYS,
	shouldRetryError: (error: unknown) => boolean = () => true,
): Promise<T> {
	for (let attempt = 0; ; attempt += 1) {
		try {
			const result = await operation();
			if (!shouldRetryResult(result) || attempt >= delays.length) return result;
		} catch (error) {
			if (!shouldRetryError(error) || attempt >= delays.length) throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
	}
}

export function fetchWithTransientRetries(
	input: RequestInfo | URL,
	init?: RequestInit,
): Promise<Response> {
	return retryTransient(
		() => fetch(input, init),
		isTransientResponse,
		DEFAULT_RETRY_DELAYS,
		(error) =>
			!init?.signal?.aborted && !(error instanceof DOMException && error.name === "AbortError"),
	);
}
