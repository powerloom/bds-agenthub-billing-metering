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

-- api_keys: only api_key_hash is stored; API secrets are shown once at mint/rotate time.
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES signup_sessions(id),
  email TEXT NOT NULL,
  api_key_hash TEXT UNIQUE NOT NULL,
  org_id TEXT NOT NULL,
  credit_balance REAL NOT NULL DEFAULT 10.0,
  total_credits_purchased REAL NOT NULL DEFAULT 0,
  total_credits_used REAL NOT NULL DEFAULT 0,
  rate_limit_rpm INTEGER NOT NULL DEFAULT 60,
  rate_limit_rpd INTEGER NOT NULL DEFAULT 1000,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  payer_address TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_keys_session ON api_keys(session_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_email ON api_keys(email);
CREATE INDEX IF NOT EXISTS idx_api_keys_payer ON api_keys(payer_address) WHERE payer_address IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_api_keys_device_session ON api_keys(session_id)
  WHERE session_id != 'b0000000-0000-4000-8000-00000000pay1';

CREATE TABLE IF NOT EXISTS credit_transactions (
  id TEXT PRIMARY KEY,
  api_key_id TEXT NOT NULL REFERENCES api_keys(id),
  amount REAL NOT NULL,
  type TEXT NOT NULL,
  description TEXT,
  http_method TEXT,
  route_template TEXT,
  request_path TEXT,
  client_source TEXT,
  tx_hash TEXT,
  chain_id INTEGER,
  plan_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_credit_tx_api_key ON credit_transactions(api_key_id);
CREATE INDEX IF NOT EXISTS idx_credit_tx_usage_endpoint
  ON credit_transactions(api_key_id, type, route_template, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS ux_credit_transactions_tx_hash ON credit_transactions(tx_hash);

-- credit_plans: GET /credits/plans; same logical `id` may exist per chain.
CREATE TABLE IF NOT EXISTS credit_plans (
  id TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  credits REAL NOT NULL,
  token_amount TEXT NOT NULL,
  token_contract TEXT NOT NULL,
  token_decimals INTEGER NOT NULL DEFAULT 6,
  label TEXT NOT NULL,
  description TEXT NOT NULL,
  offer TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  token_symbol TEXT,
  rpc_url TEXT,
  recipient TEXT,
  payment_kind TEXT NOT NULL DEFAULT 'erc20' CHECK (payment_kind IN ('erc20', 'native_value')),
  PRIMARY KEY (id, chain_id)
);

CREATE INDEX IF NOT EXISTS idx_credit_plans_chain_active_sort ON credit_plans(chain_id, active, sort_order);

CREATE TABLE IF NOT EXISTS signup_payment_quotes (
  id TEXT PRIMARY KEY,
  signup_nonce_hash TEXT UNIQUE NOT NULL,
  signup_nonce_raw TEXT,
  agent_name TEXT NOT NULL,
  email TEXT,
  plan_id TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  token_contract TEXT NOT NULL,
  token_symbol TEXT NOT NULL,
  token_decimals INTEGER NOT NULL,
  amount_atomic TEXT NOT NULL,
  payer_address TEXT NOT NULL,
  recipient TEXT NOT NULL,
  terms_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  api_key_id TEXT,
  claim_tx_hash TEXT,
  payment_kind TEXT NOT NULL DEFAULT 'erc20' CHECK (payment_kind IN ('erc20', 'native_value')),
  FOREIGN KEY (api_key_id) REFERENCES api_keys(id)
);

CREATE INDEX IF NOT EXISTS idx_quotes_pending_per_payer
  ON signup_payment_quotes(payer_address, plan_id, chain_id, consumed_at);

-- One-time server-issued messages for POST /api-key/recover/verify (wallet proves payer_address)
CREATE TABLE IF NOT EXISTS api_key_recovery_challenges (
  id TEXT PRIMARY KEY,
  address_lower TEXT NOT NULL,
  nonce TEXT NOT NULL UNIQUE,
  message TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_key_recovery_challenges_addr
  ON api_key_recovery_challenges(address_lower);
