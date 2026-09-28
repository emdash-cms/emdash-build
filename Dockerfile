ARG AGENT_BROWSER_VERSION=0.37.1

FROM node:24-slim AS browser
ARG AGENT_BROWSER_VERSION
RUN npm install -g "agent-browser@$AGENT_BROWSER_VERSION"
RUN useradd -m -s /bin/bash user
USER user
RUN agent-browser install && \
	mkdir /tmp/agent-browser-browsers && \
	mv /home/user/.agent-browser/browsers/chrome-* /tmp/agent-browser-browsers/

FROM node:24-slim

ARG AGENT_BROWSER_VERSION

# Copy the matching Sandbox server and quick-tunnel daemon from the official image.
COPY --from=docker.io/cloudflare/sandbox:0.12.10 /container-server/sandbox /sandbox
COPY --from=docker.io/cloudflare/sandbox:0.12.10 /usr/local/bin/cloudflared /usr/local/bin/cloudflared

# git/curl/squashfs plus the system libraries headless Chrome needs. agent-browser's
# own `--with-deps` shells out to `sudo apt-get` (no sudo in this image), so we
# install the libraries it lists here directly and skip `--with-deps` below.
RUN apt-get update && apt-get install -y \
	ca-certificates \
	git \
	curl \
	sqlite3 \
	squashfs-tools \
	libxcb-shm0 libx11-xcb1 libx11-6 libxcb1 libxext6 libxrandr2 libxcomposite1 \
	libxcursor1 libxdamage1 libxfixes3 libxi6 libgtk-3-0 libpangocairo-1.0-0 \
	libpango-1.0-0 libatk1.0-0 libcairo-gobject2 libcairo2 libgdk-pixbuf-2.0-0 \
	libxrender1 libasound2 libfreetype6 libfontconfig1 libdbus-1-3 libnss3 libnspr4 \
	libatk-bridge2.0-0 libdrm2 libxkbcommon0 libatspi2.0-0 libcups2 libxshmfence1 \
	libgbm1 fonts-noto-color-emoji fonts-noto-cjk fonts-freefont-ttf \
	&& rm -rf /var/lib/apt/lists/*

# Local Cloudflare devices route TLS through WARP. `pnpm predev` copies the
# host's configured CA bundle into this ignored directory; production builds
# retain only the system trust store. Keep TLS verification enabled for git,
# curl, and Node rather than using insecure per-command overrides.
COPY .dev-ca /tmp/emdash-local-ca
RUN cat /etc/ssl/certs/ca-certificates.crt > /etc/ssl/certs/emdash-ca-bundle.pem && \
	find /tmp/emdash-local-ca -type f -name '*.pem' -size +0 -exec cat {} \; \
		>> /etc/ssl/certs/emdash-ca-bundle.pem && \
	rm -rf /tmp/emdash-local-ca
ENV SSL_CERT_FILE=/etc/ssl/certs/emdash-ca-bundle.pem
ENV GIT_SSL_CAINFO=/etc/ssl/certs/emdash-ca-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/emdash-ca-bundle.pem

RUN corepack enable

# agent-browser drives a headless Chrome inside the sandbox so the agent can
# screenshot its own preview at localhost:4321 (Cloudflare Browser Run can't
# reliably reach the proxied preview URL).
RUN npm install -g "agent-browser@$AGENT_BROWSER_VERSION"

RUN useradd -m -s /bin/bash user
USER user
WORKDIR /home/user

# Match the templates' packageManager declaration and populate this user's
# Corepack cache. Preparing pnpm as root leaves a fresh sandbox downloading the
# pinned version again on its first install.
RUN corepack prepare pnpm@11.9.0 --activate

COPY --from=browser --chown=user:user /home/user/.agent-browser /home/user/.agent-browser
COPY --from=browser --chown=user:user /tmp/agent-browser-browsers/ /home/user/.agent-browser/browsers/

# The single local blank-builder scaffold is the source for all new sites.
# Install it once and retain a ready-to-extract archive in the image.
COPY --chown=user:user prototype/builder-cloudflare /home/user/.prepared/builder-cloudflare

RUN --mount=type=cache,id=emdash-template-deps,target=/tmp/pnpm-store,uid=1001,gid=1001 set -eu; \
	template=/home/user/.prepared/builder-cloudflare; \
	pnpm --dir "$template" install --ignore-scripts --store-dir /tmp/pnpm-store --reporter=append-only; \
	tar -C "$template" -czf /home/user/.prepared/builder-cloudflare.tgz .; \
	rm -rf "$template/node_modules"

EXPOSE 3000 4321

ENTRYPOINT ["/sandbox"]
