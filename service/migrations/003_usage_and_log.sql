CREATE TABLE usage_counters (
  id          BIGSERIAL   PRIMARY KEY,
  account_id  BIGINT      NOT NULL REFERENCES accounts (id),
  user_id     BIGINT      NULL,
  consumed    BIGINT      NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  period      DATE        NOT NULL,

  CONSTRAINT usage_counters_user_fk FOREIGN KEY (user_id, account_id) REFERENCES users (id, account_id),
  CONSTRAINT usage_counters_consumed_non_negative CHECK (consumed >= 0),
  CONSTRAINT usage_counters_period_is_month_start CHECK (period = date_trunc('month', period)::date)
) WITH (fillfactor = 70, autovacuum_vacuum_scale_factor = 0.05);

CREATE UNIQUE INDEX uq_counter_account
  ON usage_counters (account_id, period) WHERE user_id IS NULL;

CREATE UNIQUE INDEX uq_counter_user
  ON usage_counters (user_id, period) WHERE user_id IS NOT NULL;

CREATE TABLE request_log (
  id           BIGSERIAL   PRIMARY KEY,
  account_id   BIGINT      NOT NULL REFERENCES accounts (id),
  user_id      BIGINT      NOT NULL,
  units        BIGINT      NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  period       DATE        NOT NULL,
  request_id   TEXT        NOT NULL,
  decision     TEXT        NOT NULL,
  rejected_by  TEXT        NULL,
  rule         TEXT        NULL,
  details      JSONB       NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT request_log_user_fk FOREIGN KEY (user_id, account_id) REFERENCES users (id, account_id),
  CONSTRAINT request_log_account_request_key UNIQUE (account_id, request_id),
  CONSTRAINT request_log_request_id_not_blank CHECK (length(btrim(request_id)) > 0),
  CONSTRAINT request_log_units_positive CHECK (units > 0),
  CONSTRAINT request_log_decision_valid CHECK (decision IN ('accepted', 'rejected')),
  CONSTRAINT request_log_rejected_by_valid CHECK (rejected_by IN ('account', 'user')),
  CONSTRAINT request_log_rule_valid CHECK (rule IN ('max_per_request', 'monthly_allowance')),
  CONSTRAINT request_log_period_is_month_start CHECK (period = date_trunc('month', period)::date),
  CONSTRAINT decision_consistency CHECK (
    (decision = 'accepted' AND rejected_by IS NULL AND rule IS NULL) OR
    (decision = 'rejected' AND rejected_by IS NOT NULL AND rule IS NOT NULL)
  )
);

CREATE INDEX idx_log_account ON request_log (account_id, id DESC);
CREATE INDEX idx_log_account_period ON request_log (account_id, period, id DESC);
CREATE INDEX idx_log_account_user ON request_log (account_id, user_id, id DESC);
