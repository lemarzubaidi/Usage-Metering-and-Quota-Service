-- 001: plans
-- Plans are created first WITHOUT the owner FK (accounts does not exist yet).
-- The FK plans.owner_account_id -> accounts(id) is added in 002 (breaks the circular dependency).

CREATE TABLE plans (
  id                 BIGSERIAL   PRIMARY KEY,
  name               TEXT        NOT NULL CHECK (length(btrim(name)) > 0),
  scope              TEXT        NOT NULL CHECK (scope IN ('account', 'user')),
  monthly_allowance  BIGINT      NOT NULL CHECK (monthly_allowance >= 0),
  max_per_request    BIGINT      NOT NULL CHECK (max_per_request > 0),
  is_predefined      BOOLEAN     NOT NULL DEFAULT FALSE,
  owner_account_id   BIGINT      NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- needed as the target of the composite FKs (plan_id, plan_scope) in accounts/users
  UNIQUE (id, scope),

  -- predefined plans belong to nobody; custom plans must belong to an account
  CONSTRAINT plans_owner_matches_kind CHECK (
    (is_predefined AND owner_account_id IS NULL) OR
    (NOT is_predefined AND owner_account_id IS NOT NULL)
  )
);

-- plan names are unique per scope among predefined plans, and per owner among custom plans
CREATE UNIQUE INDEX uq_plans_predefined_name
  ON plans (scope, name) WHERE owner_account_id IS NULL;

CREATE UNIQUE INDEX uq_plans_owner_name
  ON plans (owner_account_id, scope, name) WHERE owner_account_id IS NOT NULL;
