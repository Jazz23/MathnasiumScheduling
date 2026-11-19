-- Radius accounts linked through "Login with Radius".
-- Radius has no OAuth/refresh tokens, so the app keeps the user's Radius
-- password (AES-GCM encrypted with the RADIUS_CREDENTIAL_KEY secret) to sign
-- back in on its own, plus the latest Radius session cookies.
CREATE TABLE radius_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_ciphertext TEXT NOT NULL, -- base64
  password_iv TEXT NOT NULL,         -- base64, 12 bytes
  radius_cookies TEXT,               -- "name=value; name2=value2" Cookie header
  radius_cookies_updated_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Sessions for this app (not Radius). Only a SHA-256 hash of the cookie
-- token is stored.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES radius_accounts(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX sessions_account_id ON sessions(account_id);
