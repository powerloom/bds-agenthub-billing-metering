-- signup_sessions: device-auth flow
CREATE TABLE IF NOT EXISTS signup_sessions (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  session_token_hash TEXT UNIQUE NOT NULL,
  session_token_raw TEXT NOT NULL,
  user_code TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'expired')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  verified_at TEXT,
  ip_address TEXT,
  user_agent TEXT,
  credentials_delivered INTEGER NOT NULL DEFAULT 0 CHECK (credentials_delivered IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_signup_sessions_email ON signup_sessions(email);
CREATE INDEX IF NOT EXISTS idx_signup_sessions_user_code ON signup_sessions(user_code);

-- api_keys: issued after human verifies (raw key shown once via status poll)
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES signup_sessions(id),
  email TEXT NOT NULL,
  api_key_hash TEXT UNIQUE NOT NULL,
  api_key_raw TEXT,
  org_id TEXT NOT NULL,
  credit_balance REAL NOT NULL DEFAULT 10.0,
  total_credits_purchased REAL NOT NULL DEFAULT 0,
  total_credits_used REAL NOT NULL DEFAULT 0,
  rate_limit_rpm INTEGER NOT NULL DEFAULT 60,
  rate_limit_rpd INTEGER NOT NULL DEFAULT 1000,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_keys_session ON api_keys(session_id);

CREATE TABLE IF NOT EXISTS credit_transactions (
  id TEXT PRIMARY KEY,
  api_key_id TEXT NOT NULL REFERENCES api_keys(id),
  amount REAL NOT NULL,
  type TEXT NOT NULL,
  description TEXT,
  tempo_tx_hash TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_credit_tx_api_key ON credit_transactions(api_key_id);
