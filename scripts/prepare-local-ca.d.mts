export interface PrepareLocalCaOptions {
	source?: string | null;
	targetDirectory?: string;
}

export interface PrepareLocalCaResult {
	copied: boolean;
	target: string;
}

export function prepareLocalCa(options?: PrepareLocalCaOptions): Promise<PrepareLocalCaResult>;
