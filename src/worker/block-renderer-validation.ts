export interface ValidatedBlockType {
	slug: string;
	currentVersion: number;
	versions: number[];
}

export interface ValidatedBlocksField {
	collection: string;
	field: string;
	fingerprint: string;
	allowedTypes: string[];
	retiredTypes: string[];
	types: ValidatedBlockType[];
}

export interface BlockContractEvidence {
	fields: ValidatedBlocksField[];
}

export interface BlockRendererSource {
	listAstroFiles: () => Promise<Array<{ path: string; size: number }>>;
	read: (path: string) => Promise<string | undefined>;
}

export interface BlockRendererValidationResult {
	success: boolean;
	evidence: BlockContractEvidence;
	issues: string[];
}

const MAX_TYPES = 64;
const MAX_VERSIONS = 256;
const MAX_ASTRO_FILES = 256;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function withoutComments(source: string): string {
	return source
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^\s*\/\/.*$/gm, "");
}

function fieldMapName(field: ValidatedBlocksField): string {
	return `${field.collection}_${field.field}`;
}

export async function validateBlockRendererContract(
	evidence: BlockContractEvidence,
	source: BlockRendererSource,
): Promise<BlockRendererValidationResult> {
	if (evidence.fields.length === 0) return { success: true, evidence, issues: [] };

	const issues: string[] = [];
	const types = new Map<string, Set<number>>();
	for (const field of evidence.fields) {
		for (const type of field.types) {
			const versions = types.get(type.slug) ?? new Set<number>();
			for (const version of type.versions) versions.add(version);
			types.set(type.slug, versions);
		}
	}
	const versionCount = [...types.values()].reduce((total, versions) => total + versions.size, 0);
	if (types.size > MAX_TYPES) issues.push(`More than ${MAX_TYPES} referenced block types.`);
	if (versionCount > MAX_VERSIONS)
		issues.push(`More than ${MAX_VERSIONS} retained block versions.`);

	const astroFiles = await source.listAstroFiles();
	if (astroFiles.length > MAX_ASTRO_FILES) {
		issues.push(`More than ${MAX_ASTRO_FILES} public Astro files.`);
	}
	if (astroFiles.reduce((total, file) => total + file.size, 0) > MAX_SOURCE_BYTES) {
		issues.push(`Renderer and public Astro source exceeds ${MAX_SOURCE_BYTES} bytes.`);
	}
	if (issues.length > 0) return { success: false, evidence, issues };

	let bytesRead = 0;
	const cache = new Map<string, string | undefined>();
	const read = async (path: string) => {
		if (cache.has(path)) return cache.get(path);
		const value = await source.read(path);
		bytesRead += value?.length ?? 0;
		cache.set(path, value);
		return value;
	};
	const registryPath = "src/components/blocks/index.ts";
	const registry = withoutComments((await read(registryPath)) ?? "");
	if (!registry) issues.push(`Missing ${registryPath}.`);
	const registryDispatchers = new Map<string, string>();

	for (const [slug, versions] of types) {
		const escapedSlug = escapeRegExp(slug);
		const dispatcherPath = `src/components/blocks/${slug}/index.astro`;
		const dispatcher = withoutComments((await read(dispatcherPath)) ?? "");
		if (!dispatcher) {
			issues.push(`Missing ${dispatcherPath}.`);
			continue;
		}
		const mapMatch =
			/const\s+([A-Za-z_$][\w$]*)\s*=\s*defineBlockVersionComponents\b[\s\S]*?\(\s*\{([\s\S]*?)\}\s*\)/.exec(
				dispatcher,
			);
		const map = mapMatch?.[1];
		const mapSource = mapMatch?.[2];
		const resolved = map
			? new RegExp(
					`const\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*resolveBlockVersionComponent\\([\\s\\S]*?,\\s*${escapeRegExp(map)}\\s*\\)`,
				).exec(dispatcher)?.[1]
			: undefined;
		if (
			!map ||
			!resolved ||
			!new RegExp(`<${escapeRegExp(resolved)}\\b`).test(dispatcher) ||
			!/["'][^"']*ui\/block-versions(?:\.ts)?["']/.test(dispatcher)
		) {
			issues.push(`${dispatcherPath} must dispatch through the canonical version helper map.`);
		}
		const registryDispatcher = new RegExp(
			`import\\s+([A-Za-z_$][\\w$]*)\\s+from\\s+["']\\./${escapedSlug}/index\\.astro["']`,
		).exec(registry)?.[1];
		if (!registryDispatcher) {
			issues.push(`${registryPath} must import ${slug} from its fixed dispatcher path.`);
		} else registryDispatchers.set(slug, registryDispatcher);
		for (const version of versions) {
			const versionPath = `src/components/blocks/${slug}/v${version}.astro`;
			if (!(await read(versionPath))) issues.push(`Missing ${versionPath}.`);
			const renderer = new RegExp(
				`import\\s+([A-Za-z_$][\\w$]*)\\s+from\\s+["']\\./v${version}\\.astro["']`,
			).exec(dispatcher)?.[1];
			if (!renderer) {
				issues.push(`${dispatcherPath} must import v${version}.astro.`);
			} else if (
				!mapSource ||
				!new RegExp(
					`(?:^|[,\\s])(?:${version}|["']${version}["'])\\s*:\\s*${escapeRegExp(renderer)}\\b`,
				).test(mapSource)
			) {
				issues.push(`${dispatcherPath} must map retained version ${version} to ${renderer}.`);
			}
		}
	}

	const canonicalMaps = new Set<string>();
	for (const field of evidence.fields) {
		const name = fieldMapName(field);
		canonicalMaps.add(name);
		const start = registry.search(
			new RegExp(`export\\s+const\\s+${escapeRegExp(name)}\\s*=\\s*defineBlockComponents\\b`),
		);
		if (start < 0) {
			issues.push(`${registryPath} must export the canonical ${name} block map.`);
			continue;
		}
		const nextExport = registry.indexOf("export const", start + 1);
		const mapSource = registry.slice(start, nextExport < 0 ? undefined : nextExport);
		for (const slug of [...field.allowedTypes, ...field.retiredTypes]) {
			const dispatcher = registryDispatchers.get(slug);
			if (
				!dispatcher ||
				!new RegExp(`\\b${escapeRegExp(slug)}\\s*:\\s*${escapeRegExp(dispatcher)}\\b`).test(
					mapSource,
				)
			) {
				issues.push(`${name} is missing the ${slug} dispatcher.`);
			}
		}
	}

	const usedMaps = new Set<string>();
	for (const file of astroFiles) {
		const contents = withoutComments((await read(file.path)) ?? "");
		if (!contents.includes("<Blocks")) continue;
		for (const tag of contents.matchAll(/<Blocks\b[\s\S]*?>/g)) {
			const map = /\bcomponents\s*=\s*\{\s*([A-Za-z_$][\w$]*)\s*\}/.exec(tag[0])?.[1];
			if (!map || !canonicalMaps.has(map)) {
				issues.push(`${file.path} must pass a canonical field map directly to <Blocks>.`);
				continue;
			}
			usedMaps.add(map);
			if (
				!new RegExp(
					`import\\s*\\{[^}]*\\b${escapeRegExp(map)}\\b[^}]*\\}\\s*from\\s*["'][^"']*components/blocks(?:/index)?(?:\\.ts)?["']`,
				).test(contents)
			) {
				issues.push(`${file.path} must import ${map} from the canonical blocks registry.`);
			}
		}
	}
	for (const map of canonicalMaps) {
		if (!usedMaps.has(map)) issues.push(`No public Astro route renders the canonical ${map} map.`);
	}
	if (bytesRead > MAX_SOURCE_BYTES) issues.push(`Read more than ${MAX_SOURCE_BYTES} source bytes.`);

	return { success: issues.length === 0, evidence, issues };
}
