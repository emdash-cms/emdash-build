---
name: blocks-schema-evolution
description: Use when an existing EmDash site needs a new block type, changed block fields, retained-version activation, or explicit block-content migration.
---

# Safe blocks schema evolution

Use EmDash's core versioning tools; do not implement fingerprints, versions, keys, compatibility checks, or migration logic in site source.

- For a genuinely new section, create the type with a block-only `apply_schema_plan`, update the field through `update_blocks_field`, refresh and read generated declarations, create its typed dispatcher/version files and canonical map entry, validate, then add content.
- Before updating a definition, call `schema_get_block_type`, submit the complete desired field array rather than a field patch, and pass the active version's `fingerprint` as `expectedFingerprint`.
- A compatible change takes effect immediately. Inspect the returned `currentVersion` and versions, refresh types, update its renderer, validate, and only then use the new optional capability. Defaults do not backfill stored blocks.
- For a potentially breaking update, submit the complete desired fields with `breaking: true`. Core decides compatibility. If it creates an inactive version, refresh types, add exhaustive old/new `vN.astro` renderers, run `validate_site`, then activate with the still-active old fingerprint.
- Activation never migrates content. If discovery is incomplete, stop and report it. Otherwise migrate each reported entry from a fresh raw `content_get`: preserve `_key`, order, untouched values and `_rev`, send the complete target shape with the active `_version`, set `migrateBlocks: true`, and do not set `replaceBlocks`.
- Report raced or conflicted entries honestly and revalidate after migration. Never blindly restore an older blocks array over concurrent changes.
