# Threat model

## Trust boundaries

- Browser input, generated source and WfP user Workers are untrusted.
- BuilderAgent and the provider control plane are trusted but authenticate every
  project and publication operation.
- Sandbox is disposable compute. It never receives production or Cloudflare
  account credentials.
- Site data and media are reachable only through site-scoped capabilities or a
  trusted service. A generated Worker never receives a shared DO namespace or
  shared R2 write binding.

## Anonymous projects

Project UUIDs are locators, not authorization. The server mints a random guest
identity, stores only its digest in each BuilderAgent and sends the bearer value
in an HttpOnly, SameSite cookie. Agent HTTP/WebSocket routes verify ownership
before forwarding. Guest project creation is bounded per identity.

Deleting the cookie intentionally makes anonymous projects inaccessible. Login
claiming must rotate credentials and atomically replace guest ownership; that
exchange is part of the identity-provider integration.

## Publication

- Publishing is a user action, never an autonomous model tool.
- The publisher verifies account identity, project ownership and idempotency.
- A candidate is health-checked before the stable live script changes.
- Candidate failure leaves the existing live release untouched.
- CMS authority cannot change from Sandbox to production until a core-owned
  import digest has been verified.

## Known prerelease boundaries

- Access assertion verification is injected through `IdentityAdapter`; a raw
  request header is never trusted by itself.
- Portable CMS transfer, production Draft MCP and schema compatibility remain
  unavailable until their EmDash core contracts ship.
- Guest quotas are an abuse brake, not a complete rate-limiting product.
