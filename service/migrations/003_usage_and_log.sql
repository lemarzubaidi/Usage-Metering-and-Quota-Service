-- 003: usage counters and request log

CREATE TABLE usage_counters (
  id          BIGSERIAL   PRIMARY KEY,
  account_id  BIGINT      NOT NULL REFERENCES accounts (id),
  user_id     BIGINT      NULL,                 -- NULL = the account-level counter
  period      DATE        NOT NULL,             -- first day of the UTC month, e.g. 2026-10-01
  consumed    BIGINT      NOT NULL DEFAULT 0 CHECK (consumed >= 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- a user counter must belong to a user of the same account
  FOREIGN KEY (user_id, account_id) REFERENCES users (id, account_id),

  CONSTRAINT period_is_month_start CHECK (period = date_trunc('month', period)::date)
);

-- UNIQUE with NULL does not work (NULLs are all "different"), so two partial unique indexes:
CREATE UNIQUE INDEX uq_counter_account
  ON usage_counters (account_id, period) WHERE user_id IS NULL;

CREATE UNIQUE INDEX uq_counter_user
  ON usage_counters (user_id, period) WHERE user_id IS NOT NULL;

CREATE TABLE request_log (
  id            BIGSERIAL   PRIMARY KEY,
  account_id    BIGINT      NOT NULL REFERENCES accounts (id),
  user_id       BIGINT      NOT NULL,
  request_id    TEXT        NOT NULL CHECK (length(btrim(request_id)) > 0),
  units         BIGINT      NOT NULL CHECK (units > 0),
  decision      TEXT        NOT NULL CHECK (decision IN ('accepted', 'rejected')),
  rejected_by   TEXT        NULL CHECK (rejected_by IN ('account', 'user')),
  rule          TEXT        NULL CHECK (rule IN ('max_per_request', 'monthly_allowance')),
  period        DATE        NOT NULL,
  -- snapshot of what was true when the decision was made (plans can change later,
  -- history must not): plan ids, limits, consumed-before for user and account
  details       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  FOREIGN KEY (user_id, account_id) REFERENCES users (id, account_id),

  -- THE idempotency guarantee: one outcome per (account, request_id)
  UNIQUE (account_id, request_id),

  -- consistency: accepted has no rejection info, rejected must have it
  CONSTRAINT decision_consistency CHECK (
    (decision = 'accepted' AND rejected_by IS NULL AND rule IS NULL) OR
    (decision = 'rejected' AND rejected_by IS NOT NULL AND rule IS NOT NULL)
  )
);

-- history queries: by account (+month), newest first, keyset/offset pagination
CREATE INDEX idx_log_account_period ON request_log (account_id, period, id DESC);
CREATE INDEX idx_log_user ON request_log (user_id, id DESC);
