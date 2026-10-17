CREATE TABLE accounts (
  id              BIGSERIAL   PRIMARY KEY,
  name            TEXT        NOT NULL CHECK (length(btrim(name)) > 0),
  api_key_hash    TEXT        NOT NULL UNIQUE,
  api_key_prefix  TEXT        NOT NULL,
  plan_id         BIGINT      NOT NULL,
  plan_scope      TEXT        NOT NULL DEFAULT 'account' CHECK (plan_scope = 'account'),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  FOREIGN KEY (plan_id, plan_scope) REFERENCES plans (id, scope)
);

ALTER TABLE plans
  ADD CONSTRAINT fk_plans_owner_account
  FOREIGN KEY (owner_account_id) REFERENCES accounts (id);

CREATE INDEX idx_plans_owner ON plans (owner_account_id);

CREATE TABLE users (
  id                BIGSERIAL   PRIMARY KEY,
  account_id        BIGINT      NOT NULL REFERENCES accounts (id),
  external_user_id  TEXT        NOT NULL CHECK (length(btrim(external_user_id)) > 0),
  plan_id           BIGINT      NOT NULL,
  plan_scope        TEXT        NOT NULL DEFAULT 'user' CHECK (plan_scope = 'user'),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (account_id, external_user_id),

  UNIQUE (id, account_id),

  FOREIGN KEY (plan_id, plan_scope) REFERENCES plans (id, scope)
);

CREATE INDEX idx_users_account ON users (account_id);
CREATE INDEX idx_users_plan ON users (plan_id);
