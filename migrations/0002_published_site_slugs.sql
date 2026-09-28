CREATE TABLE published_site_slugs (
	slug TEXT PRIMARY KEY NOT NULL,
	site_id TEXT UNIQUE NOT NULL,
	active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1))
);
