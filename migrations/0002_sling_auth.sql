-- Sling (getsling.com) accounts linked to an app account through "Log in to
-- Sling". Sling's login needs a reCAPTCHA, which the Worker solves with
-- CapMonster, so the app keeps the Sling password (AES-GCM encrypted with
-- RADIUS_CREDENTIAL_KEY) to sign back in when the Sling token expires.
CREATE TABLE sling_accounts (
  account_id INTEGER PRIMARY KEY REFERENCES radius_accounts(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  password_ciphertext TEXT NOT NULL, -- base64
  password_iv TEXT NOT NULL,         -- base64, 12 bytes
  sling_token TEXT,                  -- value for Sling's Authorization header
  org_id INTEGER,
  sling_token_updated_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
