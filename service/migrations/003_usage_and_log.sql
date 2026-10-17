CREATE TABLE usage_counters (
  id          BIGSERIAL   PRIMARY KEY,
  account_id  BIGINT      NOT NULL REFERENCES accounts (id),
  user_id     BIGINT      NULL,
  period      DATE        NOT NULL,
  consumed    BIGINT      NOT NULL DEFAULT 0 CHECK (consumed >= 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  FOREIGN KEY (user_id, account_id) REFERENCES users (id, account_id),

  CONSTRAINT period_is_month_start CHECK (period = date_trunc('month', period)::date)
);

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

  details       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  FOREIGN KEY (user_id, account_id) REFERENCES users (id, account_id),

  UNIQUE (account_id, request_id),

  CONSTRAINT decision_consistency CHECK (
    (decision = 'accepted' AND rejected_by IS NULL AND rule IS NULL) OR
    (decision = 'rejected' AND rejected_by IS NOT NULL AND rule IS NOT NULL)
  )
);

CREATE INDEX idx_log_account_period ON request_log (account_id, period, id DESC);
CREATE INDEX idx_log_user ON request_log (user_id, id DESC);
