CREATE TABLE auth_login_attempts (
	state_hash TEXT PRIMARY KEY NOT NULL,
	nonce_hash TEXT NOT NULL,
	guest_owner_key TEXT,
	return_path TEXT NOT NULL,
	expires_at INTEGER NOT NULL,
	consumed_at INTEGER,
	account_owner_key TEXT,
	session_hash TEXT UNIQUE,
	created_at INTEGER NOT NULL
);

CREATE INDEX auth_login_attempts_expires_at_idx ON auth_login_attempts (expires_at);

CREATE TABLE auth_sessions (
	token_hash TEXT PRIMARY KEY NOT NULL,
	account_owner_key TEXT NOT NULL,
	issuer TEXT NOT NULL,
	subject TEXT NOT NULL,
	return_path TEXT NOT NULL,
	claim_guest_owner_key TEXT,
	expires_at INTEGER NOT NULL,
	revoked_at INTEGER,
	created_at INTEGER NOT NULL
);

CREATE INDEX auth_sessions_expires_at_idx ON auth_sessions (expires_at);
CREATE INDEX auth_sessions_account_idx ON auth_sessions (account_owner_key, expires_at);
CREATE INDEX auth_sessions_revoked_at_idx ON auth_sessions (revoked_at) WHERE revoked_at IS NOT NULL;
