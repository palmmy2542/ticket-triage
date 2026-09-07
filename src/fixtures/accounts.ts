/**
 * Mock billing/account system.
 *
 * Charge ages are relative (`age_minutes`) rather than fixed timestamps so the
 * fixtures stay coherent whenever they are read - a hard-coded date would make
 * the duplicate-charge window drift out of range and quietly change eval
 * results months from now.
 *
 * Test hooks are explicit and deterministic (no random failure rates): a charge
 * id starting with `ch_fail` makes the payment provider return an error.
 */
export interface FixtureCharge {
  id: string;
  amount_cents: number;
  currency: string;
  status: 'succeeded' | 'failed' | 'refunded';
  age_minutes: number;
  description: string;
  card_last4: string;
}

export interface FixtureAccount {
  customer_id: string;
  plan: 'free' | 'pro' | 'enterprise';
  region: string;
  seats: number;
  tenure_months: number;
  /** Workspace software release - the dark-mode answer depends on it. */
  app_release: string;
  subscription_status: 'none' | 'active' | 'past_due';
  open_tickets: number;
  charges: FixtureCharge[];
}

export const ACCOUNTS: FixtureAccount[] = [
  {
    // Sample ticket 1: three captured charges, plan never provisioned.
    customer_id: 'cust_1001',
    plan: 'free',
    region: 'us-east-1',
    seats: 1,
    tenure_months: 4,
    app_release: '4.2.0',
    subscription_status: 'none',
    open_tickets: 1,
    charges: [
      {
        id: 'ch_3f21a',
        amount_cents: 2999,
        currency: 'USD',
        status: 'succeeded',
        age_minutes: 185,
        description: 'Pro plan - monthly',
        card_last4: '4242',
      },
      {
        id: 'ch_3f22b',
        amount_cents: 2999,
        currency: 'USD',
        status: 'succeeded',
        age_minutes: 122,
        description: 'Pro plan - monthly',
        card_last4: '1881',
      },
      {
        id: 'ch_3f23c',
        amount_cents: 2999,
        currency: 'USD',
        status: 'succeeded',
        age_minutes: 64,
        description: 'Pro plan - monthly',
        card_last4: '1881',
      },
    ],
  },
  {
    // Sample ticket 2: healthy billing, regional outage is the issue.
    customer_id: 'cust_2002',
    plan: 'enterprise',
    region: 'asia-southeast-1',
    seats: 45,
    tenure_months: 8,
    app_release: '4.2.0',
    subscription_status: 'active',
    open_tickets: 1,
    charges: [
      {
        id: 'ch_9a01x',
        amount_cents: 1348800,
        currency: 'USD',
        status: 'succeeded',
        age_minutes: 129600,
        description: 'Enterprise - annual, 45 seats',
        card_last4: 'invoice',
      },
    ],
  },
  {
    // Sample ticket 3: paid, healthy, on an old workspace release.
    customer_id: 'cust_3003',
    plan: 'pro',
    region: 'us-west-2',
    seats: 1,
    tenure_months: 5,
    app_release: '4.1.3',
    subscription_status: 'active',
    open_tickets: 1,
    charges: [
      {
        id: 'ch_7b55p',
        amount_cents: 2999,
        currency: 'USD',
        status: 'succeeded',
        age_minutes: 4320,
        description: 'Pro plan - monthly',
        card_last4: '0005',
      },
    ],
  },
  {
    // Test fixture: exercises payment-provider failure and already-refunded paths.
    customer_id: 'cust_9999',
    plan: 'pro',
    region: 'us-east-1',
    seats: 1,
    tenure_months: 12,
    app_release: '4.2.0',
    subscription_status: 'active',
    open_tickets: 0,
    charges: [
      {
        id: 'ch_fail_001',
        amount_cents: 1000,
        currency: 'USD',
        status: 'succeeded',
        age_minutes: 30,
        description: 'Provider always fails for this charge',
        card_last4: '0000',
      },
      {
        id: 'ch_done_002',
        amount_cents: 1000,
        currency: 'USD',
        status: 'refunded',
        age_minutes: 60,
        description: 'Already refunded',
        card_last4: '0000',
      },
    ],
  },
];

export interface RegionStatus {
  region: string;
  state: 'operational' | 'degraded' | 'outage';
  api_error_rate: number;
  active_incident_id: string | null;
  affected_services: string[];
  probe_age_seconds: number;
}

/**
 * Sample ticket 2's trap: the public status page - the thing the customer can
 * see - says everything is fine while the regional probes disagree.
 */
export const PUBLIC_STATUS_PAGE = {
  summary: 'All systems operational',
  updated_minutes_ago: 74,
  source: 'status.company.com (human-maintained)',
} as const;

export const REGION_STATUS: RegionStatus[] = [
  {
    region: 'us-east-1',
    state: 'operational',
    api_error_rate: 0.002,
    active_incident_id: null,
    affected_services: [],
    probe_age_seconds: 25,
  },
  {
    region: 'us-west-2',
    state: 'operational',
    api_error_rate: 0.001,
    active_incident_id: null,
    affected_services: [],
    probe_age_seconds: 31,
  },
  {
    region: 'eu-west-1',
    state: 'operational',
    api_error_rate: 0.004,
    active_incident_id: null,
    affected_services: [],
    probe_age_seconds: 28,
  },
  {
    region: 'asia-southeast-1',
    state: 'degraded',
    api_error_rate: 0.41,
    active_incident_id: null,
    affected_services: ['api', 'web-app'],
    probe_age_seconds: 19,
  },
];
