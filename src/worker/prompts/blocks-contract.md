## Current structured-block contract

This section is runtime-owned and overrides older scaffold guidance about structured page sections.

- Collections are independently managed entities such as products, posts, projects, people, events, and locations.
- A `blocks` field is an ordered, editor-reorderable composition of structured page sections.
- Portable Text is variable prose inside an entry or block.
- Astro components own markup, styling, responsive behaviour, accessibility, and interactions.

Use blocks only when an editor should add, duplicate, remove, or reorder a structured section. Keep fixed page chrome in Astro and repeated independent entities in collections. Invent subject-specific types from the brief; never add a generic Hero/Features/Testimonials library.

Do not declare `type: "repeater"` directly in a collection's fields: the current EmDash schema MCP cannot create collection repeaters. For ordered structured values such as project gallery images, define a subject-specific block type and use a `blocks` field. A `repeater` is valid only inside `blockTypes[].fields` when one block itself contains repeated rows.

### Initial generation

1. In one `apply_schema_plan` call, declare all subject-specific `blockTypes`, independent-entity collections, narrative-page collections, and their `blocks` fields. Definitions are created before fields that reference them.
2. Run `refresh_types`, then read `emdash-env.d.ts`. Never guess generated names or hand-author replacement block unions. If the live generated file lacks the expected unions, treat the refresh as failed and fix that boundary before continuing.
   The generated file is at the site root. Import its block unions from `src/components/blocks/index.ts` with `../../../emdash-env`, and from `src/components/blocks/<block_slug>/index.astro` or `vN.astro` with `../../../../emdash-env`. Do not guess a shorter relative path.
3. For every block `_type`, create `src/components/blocks/<block_slug>/index.astro`, typed as `BlockComponentProps<Extract<FieldBlockUnion, { _type: "..." }>>`.
4. Create `vN.astro` for every generated retained version, typed with the matching `_version`. In the dispatcher, build one exhaustive `defineBlockVersionComponents<TypeBlockUnion>({ ... })` object, pass that same object to `resolveBlockVersionComponent`, and render the resolved component with `{ value, index, blockKey }`.
5. In `src/components/blocks/index.ts`, export an exhaustive `defineBlockComponents<FieldBlockUnion>` map named `<collection>_<field>`. Import each fixed dispatcher path and map every allowed or retired `_type`.
6. Every route imports that canonical map directly and renders the stored array with `<Blocks value={entry.data.FIELD} components={collection_field} fallback={MissingBlock} />`. Use a safe production fallback, but never treat it as a substitute for complete validated coverage. Do not redeclare, alias, or partially copy the map.
7. Only after renderers exist, create and publish ordered block content. Initial blocks contain `_type` and fields; omit `_key` and `_version` so EmDash assigns them.

If `src/components/ui/block-versions.ts` is absent in a recovered project, create this exact source-owned utility:

```ts
import type { BlockComponent, BlockValue } from "emdash/ui";
export type BlockVersionComponents<T extends BlockValue> = {
	[Version in T["_version"]]: BlockComponent<Extract<T, { _version: Version }>>;
};

export function defineBlockVersionComponents<T extends BlockValue>(
	components: BlockVersionComponents<T>,
): BlockVersionComponents<T> {
	return components;
}

export function resolveBlockVersionComponent<T extends BlockValue>(
	value: T,
	components: BlockVersionComponents<T>,
): BlockComponent<T> {
	// The exhaustive mapped type and runtime lookup use this same object.
	const component = (components as Record<number, BlockComponent<T> | undefined>)[value._version];
	if (!component) {
		throw new Error(`No renderer exists for block ${value._type} version ${value._version}.`);
	}
	return component;
}
```

It contains no block names, schema, styling, or migration logic.

Ordinary editable copy and section order belong in CMS values, not the route. Public code remains server-rendered Astro/vanilla JavaScript.

For an editable internal route such as `/products`, use a string field. A block `url` field requires an absolute URL and is not an internal-path field.

### Follow-up content edits

Immediately call `content_get` with default raw values, use its current `_rev`, and send the complete desired array for the changed blocks field. Never request Markdown when round-tripping nested Portable Text. Preserve every surviving block’s `_key`, `_type`, `_version`, untouched fields, and relative content. Reorder by moving whole keyed objects. Keyless objects are only new blocks. Never use `replaceBlocks` merely to reorder or edit. On `CONFLICT`, reread and reconcile the requested change. After a successful update, call raw `content_get` again and verify the requested order/change plus every surviving key, version, and untouched value before claiming success. If verification differs, reread the latest `_rev` and reconcile only the requested delta while preserving concurrent changes; never blindly restore an older full array.

### New types and schema evolution

- For a genuinely new section: create the type with a block-only `apply_schema_plan`, update the field through `update_blocks_field`, refresh and read the changed declarations, create the typed dispatcher/version files and canonical map entry, validate, then add content.
- Before any definition update, call `schema_get_block_type`, submit the complete desired field array rather than a field patch, and pass the active version’s `fingerprint` as `expectedFingerprint`. Compatible changes take effect immediately: inspect the returned `currentVersion` and versions, refresh types, update the renderer, validate, and only then use the new optional capability. Defaults do not backfill existing blocks.
- For a potentially breaking update, first read the live active fingerprint, then submit the complete desired fields with `breaking: true`. Core decides compatibility: inspect the result because it may amend the active version instead of creating an inactive one. If it created an inactive version, refresh types, add exhaustive old/new `vN.astro` renderers, run `validate_site`, then activate with the still-active old fingerprint.
- Activation never migrates content. If `remainingIncomplete` is true, report incomplete discovery and stop. Otherwise migrate each `remainingEntries` item: call raw `content_get`, preserve `_key`, order, untouched values and `_rev`, write the complete target shape with the active `_version`, set `migrateBlocks: true`, and do not set `replaceBlocks`. Report any raced/conflicted entries honestly and revalidate after migration.

`validate_site` must pass before completion. Fix missing fixed paths, `_type` mappings, retained `_version` dispatch, unsupported versions, and rendered `data-emdash-missing-block` diagnostics rather than bypassing the validator.
