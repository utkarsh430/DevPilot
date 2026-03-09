-- Phase 1 / M15 — Stripe usage-based billing (F-PLT-06).
--
-- Adds the per-tenant ledger columns the meter aggregator and dispatcher soft
-- cutoff read/write, plus a `runs.billed_at` idempotency marker so the nightly
-- aggregator can re-run safely without double-charging.
--
-- Billing model (ratified 2026-06-02, ACE_PHASE1_PLAN.md "Locked decisions"):
--   • Usage-based with included monthly bucket + per-cent overage at a markup.
--   • Soft cutoff when balance < 0 AND no valid card; dispatcher refuses to
--     emit `agent/run.requested` and leaves a system comment on the ticket.
--
-- All additions are nullable / default-bearing so existing rows survive the
-- migration with the documented defaults applied.

-- ---------------------------------------------------------------------------
-- tenants — billing ledger columns.

alter table public.tenants
  add column if not exists stripe_customer_id     text,
  add column if not exists balance_cents          int  not null default 0,
  -- Default $5/month free credit. Operator-tunable per tenant.
  add column if not exists monthly_included_cents int  not null default 500,
  -- One of: 'valid' | 'invalid' | 'none'. Maintained by the Stripe webhook
  -- (payment_method.attached / detached / customer.updated). 'none' means
  -- the tenant has never attached a card; 'invalid' means a card was
  -- attached and then detached or expired.
  add column if not exists payment_method_status  text not null default 'none',
  -- Start of the current billing period. Used by the UI to show "current
  -- overage" vs the included monthly bucket. Not load-bearing for the meter.
  add column if not exists billing_period_start   timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'tenants_payment_method_status_chk'
  ) then
    alter table public.tenants
      add constraint tenants_payment_method_status_chk
      check (payment_method_status in ('valid','invalid','none'));
  end if;
end$$;

-- Stripe customer id is unique when present; allow NULL for un-provisioned
-- tenants (Stripe customer is created lazily on first spend).
create unique index if not exists tenants_stripe_customer_idx
  on public.tenants(stripe_customer_id)
  where stripe_customer_id is not null;

-- ---------------------------------------------------------------------------
-- runs — idempotency marker for the nightly aggregator.
--
-- NULL ⇒ not yet billed. Once set, the aggregator skips this row on
-- subsequent invocations. Set in a single SQL UPDATE per tenant per day so
-- a second cron run the same day is a no-op (the UPDATE filters on
-- `billed_at is null`).

alter table public.runs
  add column if not exists billed_at timestamptz;

create index if not exists runs_billing_lookup_idx
  on public.runs(tenant_id, status, billed_at)
  where billed_at is null;
