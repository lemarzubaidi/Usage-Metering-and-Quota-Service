\set ON_ERROR_STOP on
\pset pager off

BEGIN;

DO $$
DECLARE
  starter_id  BIGINT;
  basic_id    BIGINT;
  acc_a       BIGINT;
  acc_b       BIGINT;
  sara_a      BIGINT;
  sara_b      BIGINT;
  passed      INT := 0;
  total       INT := 0;
BEGIN
  SELECT id INTO starter_id FROM plans WHERE name = 'Starter' AND scope = 'account';
  SELECT id INTO basic_id   FROM plans WHERE name = 'Basic'   AND scope = 'user';
  IF starter_id IS NULL OR basic_id IS NULL THEN
    RAISE EXCEPTION 'Predefined plans are missing: run the migrations first';
  END IF;

  RAISE NOTICE '--- setup: two accounts, one user each (both users have external id "sara")';
  INSERT INTO accounts (name, api_key_hash, api_key_prefix, plan_id)
    VALUES ('Account A', 'verify-hash-a', 'sk_a', starter_id) RETURNING id INTO acc_a;
  INSERT INTO accounts (name, api_key_hash, api_key_prefix, plan_id)
    VALUES ('Account B', 'verify-hash-b', 'sk_b', starter_id) RETURNING id INTO acc_b;
  INSERT INTO users (account_id, external_user_id, plan_id) VALUES (acc_a, 'sara', basic_id) RETURNING id INTO sara_a;
  INSERT INTO users (account_id, external_user_id, plan_id) VALUES (acc_b, 'sara', basic_id) RETURNING id INTO sara_b;
  total := total + 1; passed := passed + 1;
  RAISE NOTICE 'OK    same external_user_id "sara" is allowed under two different accounts';

  RAISE NOTICE '--- plans and assignments';
  total := total + 1;
  BEGIN
    INSERT INTO accounts (name, api_key_hash, api_key_prefix, plan_id) VALUES ('Bad', 'verify-hash-x', 'sk_x', basic_id);
    RAISE NOTICE 'FAIL  an account was given a USER-scope plan';
  EXCEPTION WHEN OTHERS THEN
    passed := passed + 1; RAISE NOTICE 'OK    account cannot get a user-scope plan   -> %', SQLERRM;
  END;

  total := total + 1;
  BEGIN
    INSERT INTO users (account_id, external_user_id, plan_id) VALUES (acc_a, 'bad', starter_id);
    RAISE NOTICE 'FAIL  a user was given an ACCOUNT-scope plan';
  EXCEPTION WHEN OTHERS THEN
    passed := passed + 1; RAISE NOTICE 'OK    user cannot get an account-scope plan   -> %', SQLERRM;
  END;

  total := total + 1;
  BEGIN
    INSERT INTO plans (name, scope, monthly_allowance, max_per_request) VALUES ('Orphan', 'user', 10, 5);
    RAISE NOTICE 'FAIL  a custom plan without an owner was accepted';
  EXCEPTION WHEN OTHERS THEN
    passed := passed + 1; RAISE NOTICE 'OK    custom plan must have an owner account  -> %', SQLERRM;
  END;

  total := total + 1;
  BEGIN
    INSERT INTO plans (name, scope, monthly_allowance, max_per_request, owner_account_id)
      VALUES ('Negative', 'user', -1, 5, acc_a);
    RAISE NOTICE 'FAIL  a negative allowance was accepted';
  EXCEPTION WHEN OTHERS THEN
    passed := passed + 1; RAISE NOTICE 'OK    negative allowance refused               -> %', SQLERRM;
  END;

  total := total + 1;
  INSERT INTO plans (name, scope, monthly_allowance, max_per_request, owner_account_id)
    VALUES ('Interns', 'user', 200, 5, acc_a);
  passed := passed + 1;
  RAISE NOTICE 'OK    account A created its own custom plan "Interns" (stored in the same plans table)';

  RAISE NOTICE '--- users';
  total := total + 1;
  BEGIN
    INSERT INTO users (account_id, external_user_id, plan_id) VALUES (acc_a, 'sara', basic_id);
    RAISE NOTICE 'FAIL  duplicate external_user_id inside one account was accepted';
  EXCEPTION WHEN OTHERS THEN
    passed := passed + 1; RAISE NOTICE 'OK    duplicate external_user_id in one account refused -> %', SQLERRM;
  END;

  RAISE NOTICE '--- usage counters (one table: user_id NULL = the account counter)';
  INSERT INTO usage_counters (account_id, user_id, period, consumed) VALUES (acc_a, NULL, '2026-10-01', 10);
  INSERT INTO usage_counters (account_id, user_id, period, consumed) VALUES (acc_a, sara_a, '2026-10-01', 10);

  total := total + 1;
  BEGIN
    INSERT INTO usage_counters (account_id, user_id, period) VALUES (acc_a, NULL, '2026-10-01');
    RAISE NOTICE 'FAIL  a second account counter for the same month was accepted (the NULL problem)';
  EXCEPTION WHEN OTHERS THEN
    passed := passed + 1; RAISE NOTICE 'OK    one account counter per month only      -> %', SQLERRM;
  END;

  total := total + 1;
  BEGIN
    INSERT INTO usage_counters (account_id, user_id, period) VALUES (acc_a, sara_a, '2026-10-01');
    RAISE NOTICE 'FAIL  a second user counter for the same month was accepted';
  EXCEPTION WHEN OTHERS THEN
    passed := passed + 1; RAISE NOTICE 'OK    one user counter per month only         -> %', SQLERRM;
  END;

  total := total + 1;
  BEGIN
    INSERT INTO usage_counters (account_id, user_id, period) VALUES (acc_a, NULL, '2026-10-15');
    RAISE NOTICE 'FAIL  a period that is not the first day of a month was accepted';
  EXCEPTION WHEN OTHERS THEN
    passed := passed + 1; RAISE NOTICE 'OK    period must be the first day of a month -> %', SQLERRM;
  END;

  total := total + 1;
  BEGIN
    INSERT INTO usage_counters (account_id, user_id, period, consumed) VALUES (acc_a, sara_a, '2026-11-01', -5);
    RAISE NOTICE 'FAIL  negative consumed was accepted';
  EXCEPTION WHEN OTHERS THEN
    passed := passed + 1; RAISE NOTICE 'OK    consumed cannot be negative             -> %', SQLERRM;
  END;

  total := total + 1;
  BEGIN
    INSERT INTO usage_counters (account_id, user_id, period) VALUES (acc_a, sara_b, '2026-10-01');
    RAISE NOTICE 'FAIL  a counter for a user of ANOTHER account was accepted';
  EXCEPTION WHEN OTHERS THEN
    passed := passed + 1; RAISE NOTICE 'OK    cannot count usage for another account''s user -> %', SQLERRM;
  END;

  RAISE NOTICE '--- request log (history + idempotency)';
  INSERT INTO request_log (account_id, user_id, request_id, units, decision, period)
    VALUES (acc_a, sara_a, 'req-1', 10, 'accepted', '2026-10-01');

  total := total + 1;
  BEGIN
    INSERT INTO request_log (account_id, user_id, request_id, units, decision, period)
      VALUES (acc_a, sara_a, 'req-1', 10, 'accepted', '2026-10-01');
    RAISE NOTICE 'FAIL  the same request_id was recorded twice (double charge possible)';
  EXCEPTION WHEN OTHERS THEN
    passed := passed + 1; RAISE NOTICE 'OK    same request_id twice in one account refused (idempotency) -> %', SQLERRM;
  END;

  total := total + 1;
  INSERT INTO request_log (account_id, user_id, request_id, units, decision, period)
    VALUES (acc_b, sara_b, 'req-1', 10, 'accepted', '2026-10-01');
  passed := passed + 1;
  RAISE NOTICE 'OK    the same request_id "req-1" is fine in a different account';

  total := total + 1;
  BEGIN
    INSERT INTO request_log (account_id, user_id, request_id, units, decision, period)
      VALUES (acc_a, sara_a, 'req-2', 10, 'rejected', '2026-10-01');
    RAISE NOTICE 'FAIL  a rejected request without rejected_by/rule was accepted';
  EXCEPTION WHEN OTHERS THEN
    passed := passed + 1; RAISE NOTICE 'OK    rejected request must say who/which rule -> %', SQLERRM;
  END;

  total := total + 1;
  BEGIN
    INSERT INTO request_log (account_id, user_id, request_id, units, decision, rejected_by, rule, period)
      VALUES (acc_a, sara_a, 'req-3', 10, 'accepted', 'user', 'max_per_request', '2026-10-01');
    RAISE NOTICE 'FAIL  an accepted request carrying a rejection reason was accepted';
  EXCEPTION WHEN OTHERS THEN
    passed := passed + 1; RAISE NOTICE 'OK    accepted request cannot carry a rejection reason -> %', SQLERRM;
  END;

  total := total + 1;
  BEGIN
    INSERT INTO request_log (account_id, user_id, request_id, units, decision, period)
      VALUES (acc_a, sara_a, 'req-4', 0, 'accepted', '2026-10-01');
    RAISE NOTICE 'FAIL  units = 0 was accepted';
  EXCEPTION WHEN OTHERS THEN
    passed := passed + 1; RAISE NOTICE 'OK    units must be positive                   -> %', SQLERRM;
  END;

  total := total + 1;
  BEGIN
    INSERT INTO request_log (account_id, user_id, request_id, units, decision, period)
      VALUES (acc_a, sara_b, 'req-5', 10, 'accepted', '2026-10-01');
    RAISE NOTICE 'FAIL  a log row for a user of ANOTHER account was accepted';
  EXCEPTION WHEN OTHERS THEN
    passed := passed + 1; RAISE NOTICE 'OK    cannot log a request for another account''s user -> %', SQLERRM;
  END;

  RAISE NOTICE '=== % of % checks passed', passed, total;
  IF passed <> total THEN
    RAISE EXCEPTION 'Some checks failed';
  END IF;
END $$;

ROLLBACK;

\echo
\echo 'Rolled back: no test data was kept. Predefined plans currently in the database:'
SELECT id, name, scope, monthly_allowance, max_per_request FROM plans WHERE is_predefined ORDER BY id;
