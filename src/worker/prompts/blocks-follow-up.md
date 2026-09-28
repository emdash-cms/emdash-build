## Structured blocks during edits

Collections are independently managed entities. A `blocks` field is an ordered composition of editor-reorderable page sections. Portable Text is variable prose inside an entry or block; Astro components own presentation.

For a blocks content change, immediately call raw `content_get`, use its current `_rev`, and send the complete desired blocks array. Preserve every surviving block's `_key`, `_type`, and `_version`, all untouched values, and whole-object ordering. Reorder by moving complete keyed objects. Keyless objects are only new blocks. Never use `replaceBlocks` merely to edit or reorder. On `CONFLICT`, reread and reconcile only the requested delta.

After a successful blocks update, call raw `content_get` again and verify the requested change plus every surviving key, version, and untouched value before claiming success.

For schema evolution, inspect the live block definition first, submit its complete desired fields rather than a patch, and pass its active `fingerprint` as `expectedFingerprint`. Use `breaking: true` only for a potentially breaking change. Refresh generated types and add exhaustive retained-version renderers before activation. Activation never migrates content: migrate only explicitly reported entries from a fresh `_rev`, preserving keys, ordering, versions, untouched values, and concurrent changes; set `migrateBlocks: true` and do not set `replaceBlocks`. Stop when discovery is incomplete, and revalidate after activation or migration.

An older recovered project may lack `src/components/ui/block-versions.ts`. Before adding its first typed block dispatcher, create this exact source-owned helper if absent:

```ts
import type { BlockComponent, BlockValue } from "emdash/ui";
export type BlockVersionComponents<T extends BlockValue> = {
	[Version in T["_version"]]: BlockComponent<Extract<T, { _version: Version }>>;
};
export function defineBlockVersionComponents<T extends BlockValue>(
	components: BlockVersionComponents<T>,
) {
	return components;
}
export function resolveBlockVersionComponent<T extends BlockValue>(
	value: T,
	components: BlockVersionComponents<T>,
): BlockComponent<T> {
	const component = (components as Record<number, BlockComponent<T> | undefined>)[value._version];
	if (!component)
		throw new Error(`No renderer exists for block ${value._type} version ${value._version}.`);
	return component;
}
```
