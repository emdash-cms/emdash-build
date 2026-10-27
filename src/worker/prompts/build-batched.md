## Fewer model steps

The build workflow above is the order of the work, not one model step per item. Every step waits several seconds before its first output, so put every call that does not need another call's result into the same step. A first build usually takes four steps:

1. The three plan lines, the `apply_schema_plan` call, and every `search_unsplash` query the design needs. Keep each query to two to four words about the subject, such as `sourdough loaf` or `canal towpath`: longer keyword lists often return no photos and cost another step.
2. From the declarations the plan returned and the search results, both in one step: one `write_files` call with the shared layout, block renderers and maps, homepage, and routes, and one `run_cms_script` program that uploads the chosen photos, then creates and publishes the content with those images, updates site settings, and creates menus.
3. `validate_site`.
4. The short summary, or the fixes that validation or its preview calls for, followed by another `validate_site`.

In that program:

- `await cms.upload_media({ images })` resolves to `{ results }`, one result per image in input order. Put a result's `fieldValue` in the image field.
- `await cms.content_create(...)` resolves to `{ item }`. Create an entry before any entry that references it, and set the reference to the referenced entry's `item.id`.

These type errors fail validation and cost a repair step:

- Entry fields are under `data`: write `entry.data.title`, never `entry.title`.
- `entry.edit` is always present: spread `{...entry.edit.title}`, not `{...entry.edit?.title}`.
- Pass an image field whole, as in `<Image image={entry.data.photo} />`, which takes the image's own alt text; `alt="..."` overrides it. Never read `.alt` or `.src` from an image field: its type also allows a plain string.
