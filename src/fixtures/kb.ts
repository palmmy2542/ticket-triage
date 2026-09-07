/**
 * Mock knowledge base.
 *
 * A typed module rather than markdown files on disk: no frontmatter parser, no
 * fs access, no build-time copying, and the compiler checks every entry. The
 * assignment explicitly asks for "a handful of mock FAQ docs", and a real
 * deployment would swap this module for a retriever behind the same shape -
 * `search_knowledge_base` never learns where the docs came from.
 */
export interface KbDoc {
  id: string;
  title: string;
  tags: string[];
  body: string;
}

export const KB_DOCS: KbDoc[] = [
  {
    id: 'billing-payment-failed',
    title: 'Why did my payment fail?',
    tags: ['billing', 'payment', 'card', 'declined', 'upgrade', 'charge'],
    body: [
      'Card payments fail most often because the issuing bank declines the charge, the card requires',
      '3D Secure confirmation that was not completed, or the billing address does not match.',
      'A declined attempt can still leave a temporary authorization hold on the account, which the',
      'bank releases within 5-7 business days without any action from us.',
      'If you retried with a second card you may see more than one hold. Only one payment is captured;',
      'any additional captured charges are duplicates and support can refund them. Refunds are issued',
      'to the original payment method and take 5-10 business days to appear on a statement.',
    ].join(' '),
  },
  {
    id: 'billing-upgrade-not-applied',
    title: 'I paid but my plan still shows Free',
    tags: ['billing', 'upgrade', 'plan', 'entitlement', 'pro', 'provisioning'],
    body: [
      'Plan changes normally apply within a minute of a successful payment. When a charge is captured',
      'but the plan still shows Free, the subscription record failed to provision - the payment and the',
      'entitlement are written by separate systems.',
      'Support can reconcile this manually: they confirm which charge to keep, refund any duplicates,',
      'and apply the paid plan to the account. Customers cannot fix this from the billing screen, and',
      'retrying the purchase usually creates another duplicate charge rather than granting access.',
    ].join(' '),
  },
  {
    id: 'appearance-dark-mode',
    title: 'Dark mode: availability and the System Default setting',
    tags: ['ui', 'dark mode', 'theme', 'appearance', 'settings', 'light', 'macos'],
    body: [
      'Dark mode is available on all paid plans from workspace release 4.2 onward. It appears as a',
      'third option, "Dark", under Settings > Appearance.',
      'If Settings > Appearance only offers "Light" and "System Default", the workspace is still on',
      'release 4.1 or earlier; a workspace admin can apply the pending update from Settings > General.',
      'Release 4.1 also has a known defect: "System Default" reads the operating system theme only at',
      'sign-in on macOS, so switching macOS to dark while the app is open leaves the app in light mode.',
      'Both issues are resolved by updating to 4.2, where selecting "Dark" applies immediately.',
      'Scheduling a theme change at a fixed time of day is not supported today; it is a tracked feature request.',
    ].join(' '),
  },
  {
    id: 'platform-error-500',
    title: 'Seeing error 500 or a blank screen',
    tags: ['platform', 'outage', '500', 'error', 'down', 'region', 'status'],
    body: [
      'An HTTP 500 is a server-side failure, not a browser or account problem, so clearing cache or',
      'switching browsers will not change it.',
      'Our platform is deployed per region and an incident can affect one region while others are',
      'healthy. The public status page is updated by the on-call engineer and can lag an incident by',
      'several minutes, so it may still read "all systems operational" during a regional problem.',
      'When several people on the same account are affected at once, treat it as a platform incident',
      'and include the account region and the time the errors began.',
    ].join(' '),
  },
  {
    id: 'account-seats',
    title: 'Managing seats on an Enterprise workspace',
    tags: ['account', 'seats', 'enterprise', 'members', 'invite'],
    body: [
      'Workspace admins manage seats under Settings > Members. Adding a member consumes a seat',
      'immediately and is billed pro rata at the next invoice; removing a member frees the seat at the',
      'end of the billing period. Seat totals on Enterprise plans are contractual, so raising the cap',
      'requires an account manager rather than a self-service change.',
    ].join(' '),
  },
  {
    id: 'api-rate-limits',
    title: 'API rate limits and 429 responses',
    tags: ['api', 'rate limit', '429', 'throttling', 'retry'],
    body: [
      'The API allows 600 requests per minute per workspace on Pro and 3000 on Enterprise. Exceeding',
      'the limit returns HTTP 429 with a Retry-After header. Clients should retry with exponential',
      'backoff and jitter rather than a fixed delay, and batch endpoints should be preferred over',
      'per-item calls for bulk work.',
    ].join(' '),
  },
  {
    id: 'exports-pro',
    title: 'Export formats on the Pro plan',
    tags: ['export', 'pro', 'pdf', 'csv', 'features'],
    body: [
      'Pro adds PDF and PowerPoint export alongside the CSV export available on Free. Exports run',
      'server-side and are emailed as a download link when a document is large. Export options appear',
      'under the share menu once the workspace plan is Pro; they are hidden while the plan is Free,',
      'even if a payment is in flight.',
    ].join(' '),
  },
];
