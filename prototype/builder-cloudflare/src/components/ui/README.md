# Public UI primitives

These are source-owned Astro components for the generated public site. They are
adapted from Accessible Astro Components and intentionally contain no React.

Every primitive accepts `class`. Props marked `*` are required; defaults are in
parentheses.

- `SkipLink`: `href`\*. Keyboard-visible bypass link, e.g. `href="#main-content"`.
- `Button`: `href`, `type` (`button`), `variant` (`solid` | `outline` | `ghost`),
  `ariaLabel`, `disabled`. Renders `<a>` when `href` is set, otherwise
  `<button>`. Other attributes pass through: `data-*` and ARIA on both,
  `target`/`rel` only with `href`, `name`/`value`/`form` only without.
  `disabled` applies to the `<button>` form only.
- `Card`: `as` (`div` | `article` | `section` | `li`). Unopinionated container.
- `Accordion`: `label`. Wraps `AccordionItem`s.
- `AccordionItem`: `title`\*, `name`, `open`. Native `details`; items sharing a
  `name` open one at a time.
- `Dialog`: `id`\*, `title`\*, `description`, `closeLabel`. Native modal. Open it
  with a button carrying `data-dialog-trigger="<dialog id>"`, e.g.
  `<Button data-dialog-trigger="menu">` (no `href`). Focus returns to the
  trigger on close.
- `Field`: `for`\*, `label`\*, `hint`, `error`. Label, hint, and error around one
  control; their ids are `<for>-hint` and `<for>-error`.
- `Input`: `id`\*, `name`\*, `type` (`text` | `email` | `tel` | `url` | `number` |
  `search` | `password` | `date` | `time`), `required`, `disabled`,
  `autocomplete`, `placeholder`, `describedBy` (pass the Field's hint/error ids).
- `Textarea`: `id`\*, `name`\*, `rows` (`5`), `required`, `disabled`,
  `placeholder`, `describedBy`.
- `Checkbox`: `id`\*, `name`\*, `label`\*, `value` (`on`), `checked`, `required`,
  `disabled`.
- `RichText`: `value`\*, plus any EmDash `PortableText` prop. Renders Portable
  Text with heading, list, link, and quote styles using `--site-muted` and
  `--site-line`; utilities in `class` override them.

Use these for low-level controls. Build site-specific heroes, galleries,
product lists, stories, calls to action, headers, and footers as ordinary Astro
components. Do not turn every section into a generic `Card`.

You may modify their Tailwind classes, but preserve:

- native element semantics
- visible `focus-visible` styles
- programmatic labels and descriptions
- keyboard operation and Escape behaviour
- reduced-motion handling
- minimum touch-target sizes

React is installed only for the EmDash admin. Do not import it here and do not
hydrate public components with an Astro `client:*` directive.
