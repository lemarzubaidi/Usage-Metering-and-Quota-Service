-- 002: accounts and users

CREATE TABLE accounts (
  id              BIGSERIAL   PRIMARY KEY,
  name            TEXT        NOT NULL CHECK (length(btrim(name)) > 0),
  api_key_hash    TEXT        NOT NULL UNIQUE,   -- SHA-256 hex of the key; the raw key is never stored
  api_key_prefix  TEXT        NOT NULL,          -- first chars, so an owner can recognise a key safely
  plan_id         BIGINT      NOT NULL,
  plan_scope      TEXT        NOT NULL DEFAULT 'account' CHECK (plan_scope = 'account'),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- (plan_id, plan_scope) must exist in plans AND scope must be 'account':
  -- the database itself stops a user-scope plan from being assigned to an account.
  FOREIGN KEY (plan_id, plan_scope) REFERENCES plans (id, scope)
);

-- now that accounts exists, close the circle
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

  -- the same external id may exist under two different accounts, never twice in one
  UNIQUE (account_id, external_user_id),

  -- target for composite FKs that must prove "this user belongs to this account"
  UNIQUE (id, account_id),

  FOREIGN KEY (plan_id, plan_scope) REFERENCES plans (id, scope)
);

CREATE INDEX idx_users_account ON users (account_id);
CREATE INDEX idx_users_plan ON users (plan_id);

-- NOTE: "a custom plan may only be assigned inside its owner account" cannot be a plain
-- FK/CHECK (it compares rows across tables). It is enforced in the service layer.
