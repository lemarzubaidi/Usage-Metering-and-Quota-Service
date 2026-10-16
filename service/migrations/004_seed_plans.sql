-- 004: predefined plans (idempotent: safe to re-run)
-- Account plans:  Starter 10,000/month, 100 per request | Pro 100,000/month, 1,000 per request
-- User plans:     Basic   1,000/month,  20 per request  | Premium 10,000/month, 200 per request

INSERT INTO plans (name, scope, monthly_allowance, max_per_request, is_predefined, owner_account_id) VALUES
  ('Starter', 'account',  10000,  100, TRUE, NULL),
  ('Pro',     'account', 100000, 1000, TRUE, NULL),
  ('Basic',   'user',      1000,   20, TRUE, NULL),
  ('Premium', 'user',     10000,  200, TRUE, NULL)
ON CONFLICT (scope, name) WHERE owner_account_id IS NULL DO NOTHING;
