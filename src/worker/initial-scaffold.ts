import type { BatchReadResult } from "./tools.js";

export const INITIAL_SCAFFOLD_PATHS = [
	"AGENTS.md",
	"src/components/ui/README.md",
	"src/layouts/SiteLayout.astro",
	"src/styles/global.css",
	"src/pages/index.astro",
	"package.json",
] as const;

const TEMPLATE_GUIDANCE_PATH = "AGENTS.md";

export interface InitialScaffoldFile {
	path: string;
	content: string;
	bytes: number;
}

export interface InitialScaffoldContext {
	templateGuidance?: string;
	files: InitialScaffoldFile[];
	missingPaths: string[];
}

export function createInitialScaffoldContext(result: BatchReadResult): InitialScaffoldContext {
	let templateGuidance: string | undefined;
	const files: InitialScaffoldFile[] = [];
	const missingPaths: string[] = [];
	for (const file of result.files) {
		if (!file.success) {
			if (file.path !== TEMPLATE_GUIDANCE_PATH) missingPaths.push(file.path);
			continue;
		}
		if (file.path === TEMPLATE_GUIDANCE_PATH) {
			templateGuidance = file.content;
			continue;
		}
		files.push({
			path: file.path,
			content: file.content,
			bytes: new TextEncoder().encode(file.content).byteLength,
		});
	}
	return { templateGuidance, files, missingPaths };
}

export function emptyInitialScaffoldContext(): InitialScaffoldContext {
	return {
		files: [],
		missingPaths: INITIAL_SCAFFOLD_PATHS.filter((path) => path !== TEMPLATE_GUIDANCE_PATH),
	};
}

/** In-memory attempt ownership for optional scaffold reads. */
export class InitialScaffoldPrefetch {
	private attempt = 0;
	private controller?: AbortController;
	private promise?: Promise<InitialScaffoldContext>;

	start(
		load: (signal: AbortSignal) => Promise<InitialScaffoldContext>,
		publish: (context: InitialScaffoldContext) => void,
	): Promise<InitialScaffoldContext> {
		this.controller?.abort();
		const attempt = ++this.attempt;
		const controller = new AbortController();
		this.controller = controller;
		const promise = load(controller.signal).then((context) => {
			if (this.attempt === attempt) publish(context);
			return context;
		});
		this.promise = promise;
		return promise;
	}

	current(): Promise<InitialScaffoldContext> | undefined {
		return this.promise;
	}

	cancel(): void {
		this.attempt += 1;
		this.controller?.abort();
		this.controller = undefined;
		this.promise = undefined;
	}
}
