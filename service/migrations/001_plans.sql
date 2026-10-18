CREATE TABLE plans (
  id                 BIGSERIAL   PRIMARY KEY,
  monthly_allowance  BIGINT      NOT NULL,
  max_per_request    BIGINT      NOT NULL,
  owner_account_id   BIGINT      NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_predefined      BOOLEAN     NOT NULL DEFAULT FALSE,
  name               TEXT        NOT NULL,
  scope              TEXT        NOT NULL,

  CONSTRAINT plans_id_scope_key UNIQUE (id, scope),
  CONSTRAINT plans_name_not_blank CHECK (length(btrim(name)) > 0),
  CONSTRAINT plans_scope_valid CHECK (scope IN ('account', 'user')),
  CONSTRAINT plans_allowance_non_negative CHECK (monthly_allowance >= 0),
  CONSTRAINT plans_max_per_request_positive CHECK (max_per_request > 0),
  CONSTRAINT plans_owner_matches_kind CHECK (
    (is_predefined AND owner_account_id IS NULL) OR
    (NOT is_predefined AND owner_account_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX uq_plans_predefined_name
  ON plans (scope, name) WHERE owner_account_id IS NULL;

CREATE UNIQUE INDEX uq_plans_owner_name
  ON plans (owner_account_id, scope, name) WHERE owner_account_id IS NOT NULL;
