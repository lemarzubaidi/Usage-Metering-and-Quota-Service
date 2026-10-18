CREATE TABLE accounts (
  id              BIGSERIAL   PRIMARY KEY,
  plan_id         BIGINT      NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  name            TEXT        NOT NULL,
  api_key_hash    TEXT        NOT NULL,
  api_key_prefix  TEXT        NOT NULL,
  plan_scope      TEXT        NOT NULL DEFAULT 'account',

  CONSTRAINT accounts_api_key_hash_key UNIQUE (api_key_hash),
  CONSTRAINT accounts_name_not_blank CHECK (length(btrim(name)) > 0),
  CONSTRAINT accounts_plan_is_account_scope CHECK (plan_scope = 'account'),
  CONSTRAINT accounts_plan_fk FOREIGN KEY (plan_id, plan_scope) REFERENCES plans (id, scope)
);

ALTER TABLE plans
  ADD CONSTRAINT fk_plans_owner_account
  FOREIGN KEY (owner_account_id) REFERENCES accounts (id);

CREATE INDEX idx_plans_owner ON plans (owner_account_id);
CREATE INDEX idx_accounts_plan ON accounts (plan_id);

CREATE TABLE users (
  id                BIGSERIAL   PRIMARY KEY,
  account_id        BIGINT      NOT NULL REFERENCES accounts (id),
  plan_id           BIGINT      NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  external_user_id  TEXT        NOT NULL,
  plan_scope        TEXT        NOT NULL DEFAULT 'user',

  CONSTRAINT users_account_external_key UNIQUE (account_id, external_user_id),
  CONSTRAINT users_id_account_key UNIQUE (id, account_id),
  CONSTRAINT users_external_id_not_blank CHECK (length(btrim(external_user_id)) > 0),
  CONSTRAINT users_plan_is_user_scope CHECK (plan_scope = 'user'),
  CONSTRAINT users_plan_fk FOREIGN KEY (plan_id, plan_scope) REFERENCES plans (id, scope)
);

CREATE INDEX idx_users_plan ON users (plan_id);
