/**
 * Integration Providers — concrete registrations
 *
 * The full MVP-5 + 27 `DataConnectionProvider` enum wiring.
 *
 * MVP-5 platform providers (synthetic probes + Cockatiel breakers +
 * statuspage polling): `openai`, `anthropic`, `stripe`, `resend`,
 * `aws_s3`. These are PLATFORM dependencies — an outage degrades the
 * whole product.
 *
 * 27 DataConnectionProvider enum values: statuspage polling only (no
 * synthetic probes, no breakers — these are per-tenant integrations
 * that users configure). Providers without a public Atlassian
 * Statuspage `summary.json` are marked `statusPagePolling: false` and
 * render `UNKNOWN` in the badge.
 *
 * Imported for side effects only — see `./register-providers.ts` for
 * the entry point that pulls this in at boot.
 */

import { registerIntegrationProvider } from "./integration-registry";

// =============================================================================
// MVP-5 — Platform providers (synthetic probes + Cockatiel breakers + statuspage)
// =============================================================================

registerIntegrationProvider({
	key: "openai",
	displayName: "OpenAI",
	statusPageUrl: "https://status.openai.com",
	statusPageApiUrl: "https://status.openai.com/api/v2/summary.json",
	statusPagePolling: true,
	// Cheapest verifiable call: `GET /v1/models`. List-models is rate-limited
	// generously and costs zero tokens.
	syntheticProbe: {
		interval: "5m",
		url: "https://api.openai.com/v1/models",
		method: "GET",
		expectedStatus: [200],
		authHeaderEnvVar: "OPENAI_API_KEY",
		timeoutMs: 15_000,
	},
	breakerKey: "openai_completions",
	affectedFeatures: ["ai_generation"],
});

registerIntegrationProvider({
	key: "anthropic",
	displayName: "Anthropic",
	statusPageUrl: "https://status.anthropic.com",
	statusPageApiUrl: "https://status.anthropic.com/api/v2/summary.json",
	statusPagePolling: true,
	// Anthropic does not expose a free list-models endpoint; the cheapest
	// verifiable call is `GET /v1/models` on the public API. The
	// `x-api-key` header is the Anthropic convention (not Bearer), so
	// the generic probe injects the env var into the static headers map
	// rather than the Authorization header. The generic runtime handles
	// the swap when `authHeaderEnvVar` is unset and `headers` includes
	// `x-api-key` as the literal env-var name in `${...}` form.
	syntheticProbe: {
		interval: "5m",
		url: "https://api.anthropic.com/v1/models",
		method: "GET",
		expectedStatus: [200],
		headers: {
			"anthropic-version": "2023-06-01",
			"x-api-key": "${ANTHROPIC_API_KEY}",
		},
		timeoutMs: 15_000,
	},
	breakerKey: "anthropic_messages",
	affectedFeatures: ["ai_generation"],
});

registerIntegrationProvider({
	key: "stripe",
	displayName: "Stripe",
	statusPageUrl: "https://status.stripe.com",
	statusPageApiUrl: "https://status.stripe.com/api/v2/summary.json",
	statusPagePolling: true,
	// Cheapest verifiable call: `GET /v1/balance` — returns the
	// platform's Stripe balance without side effects.
	syntheticProbe: {
		interval: "5m",
		url: "https://api.stripe.com/v1/balance",
		method: "GET",
		expectedStatus: [200],
		authHeaderEnvVar: "STRIPE_SECRET_KEY",
		timeoutMs: 15_000,
	},
	breakerKey: "stripe_payments",
	affectedFeatures: ["payments"],
});

registerIntegrationProvider({
	key: "resend",
	displayName: "Resend",
	statusPageUrl: "https://resend-status.com",
	statusPageApiUrl: "https://resend-status.com/api/v2/summary.json",
	statusPagePolling: true,
	// Cheapest verifiable call: `GET /domains` — returns the configured
	// domain list without side effects.
	syntheticProbe: {
		interval: "5m",
		url: "https://api.resend.com/domains",
		method: "GET",
		expectedStatus: [200],
		authHeaderEnvVar: "RESEND_API_KEY",
		timeoutMs: 15_000,
	},
	breakerKey: "resend_email",
	affectedFeatures: ["transactional_email"],
});

registerIntegrationProvider({
	key: "aws_s3",
	displayName: "AWS S3",
	statusPageUrl: "https://health.aws.amazon.com/health/status",
	// AWS Health does not expose a public summary.json
	statusPageApiUrl: undefined,
	statusPagePolling: false,
	// S3 does not have an HTTP `/v1/health` endpoint; the canonical
	// liveness probe is `HeadBucket` via the AWS SDK. The generic
	// runtime dispatches to a single registered SDK function when
	// `clientProbeFn` is set.
	syntheticProbe: {
		interval: "5m",
		clientProbeFn: "s3-head-canary",
		timeoutMs: 15_000,
	},
	breakerKey: "aws_s3_put",
	affectedFeatures: ["file_storage", "document_processing"],
});

// =============================================================================
// 27 DataConnectionProvider enum values — statuspage poll only (no synthetic
// probe, no Cockatiel breaker — these are user-configured per-tenant
// integrations, not platform dependencies). One entry per enum value.
// =============================================================================

registerIntegrationProvider({
	key: "google_drive",
	displayName: "Google Drive",
	statusPageUrl: "https://www.google.com/appsstatus/dashboard/",
	// Google Workspace serves the per-product incident list as a JSON
	// array (NOT the Atlassian Statuspage shape). The `google-workspace`
	// custom parser narrows on `service_name`.
	statusPageApiUrl:
		"https://www.google.com/appsstatus/dashboard/incidents.json",
	statusPagePolling: true,
	customParser: "google-workspace",
	googleWorkspaceServiceName: "Google Drive",
	affectedFeatures: [],
	dataConnectionProvider: "GOOGLE_DRIVE",
});

registerIntegrationProvider({
	key: "s3",
	displayName: "S3 (Generic)",
	statusPageUrl: undefined,
	statusPagePolling: false,
	statusUnsupportedReason:
		"Non-AWS S3-compatible providers expose no single public health feed",
	affectedFeatures: [],
	dataConnectionProvider: "S3",
});

registerIntegrationProvider({
	key: "google_storage",
	displayName: "Google Cloud Storage",
	statusPageUrl: "https://status.cloud.google.com",
	statusPageApiUrl: "https://status.cloud.google.com/incidents.json",
	statusPagePolling: true,
	customParser: "google-cloud",
	googleCloudProductTitle: "Cloud Storage",
	affectedFeatures: [],
	dataConnectionProvider: "GOOGLE_STORAGE",
});

registerIntegrationProvider({
	key: "r2",
	displayName: "Cloudflare R2",
	statusPageUrl: "https://www.cloudflarestatus.com",
	statusPageApiUrl: "https://www.cloudflarestatus.com/api/v2/summary.json",
	statusPagePolling: true,
	// Cloudflare's statuspage lists incidents for the whole platform —
	// Workers, R2, Pages, Stream, Billing, etc. Without filtering, a
	// Billing incident shows up as a "Cloudflare R2" outage in our UI.
	// The component name is the literal string Cloudflare uses on the
	// page; both aliases are registered defensively in case Cloudflare
	// renames (they historically called it "R2 Object Storage").
	statusPageComponents: ["R2", "R2 Object Storage"],
	affectedFeatures: [],
	dataConnectionProvider: "R2",
});

registerIntegrationProvider({
	key: "dropbox",
	displayName: "Dropbox",
	statusPageUrl: "https://status.dropbox.com",
	statusPageApiUrl: "https://status.dropbox.com/api/v2/summary.json",
	statusPagePolling: true,
	affectedFeatures: [],
	dataConnectionProvider: "DROPBOX",
});

registerIntegrationProvider({
	key: "airtable",
	displayName: "Airtable",
	statusPageUrl: "https://status.airtable.com",
	statusPageApiUrl: "https://status.airtable.com/api/v2/summary.json",
	statusPagePolling: true,
	affectedFeatures: [],
	dataConnectionProvider: "AIRTABLE",
});

registerIntegrationProvider({
	key: "coda",
	displayName: "Coda",
	statusPageUrl: "https://status.coda.io",
	statusPageApiUrl: "https://status.coda.io/api/v2/summary.json",
	statusPagePolling: true,
	affectedFeatures: [],
	dataConnectionProvider: "CODA",
});

registerIntegrationProvider({
	key: "gitbook",
	displayName: "GitBook",
	// GitBook migrated from Atlassian Statuspage to incident.io. The old
	// host `status.gitbook.com` returns HTML; the new host serves the
	// same Atlassian-compatible JSON shape so the default parser works.
	statusPageUrl: "https://www.gitbookstatus.com",
	statusPageApiUrl: "https://www.gitbookstatus.com/api/v2/summary.json",
	statusPagePolling: true,
	affectedFeatures: [],
	dataConnectionProvider: "GITBOOK",
});

registerIntegrationProvider({
	key: "notion",
	displayName: "Notion",
	// Notion migrated from Atlassian Statuspage to incident.io. The old
	// `status.notion.so` host now 301s to `www.notion-status.com` which
	// returns HTML; the JSON endpoint lives directly on the new host.
	statusPageUrl: "https://www.notion-status.com",
	statusPageApiUrl: "https://www.notion-status.com/api/v2/summary.json",
	statusPagePolling: true,
	affectedFeatures: [],
	dataConnectionProvider: "NOTION",
});

registerIntegrationProvider({
	key: "confluence",
	displayName: "Confluence",
	statusPageUrl: "https://status.atlassian.com",
	statusPageApiUrl: "https://status.atlassian.com/api/v2/summary.json",
	statusPagePolling: true,
	affectedFeatures: [],
	dataConnectionProvider: "CONFLUENCE",
});

registerIntegrationProvider({
	key: "teams",
	displayName: "Microsoft Teams",
	statusPageUrl: "https://portal.office.com/servicestatus",
	// Requires authenticated Microsoft 365 admin API
	statusPagePolling: false,
	statusUnsupportedReason:
		"Microsoft Service Health requires authenticated admin access",
	affectedFeatures: [],
	dataConnectionProvider: "TEAMS",
});

registerIntegrationProvider({
	key: "intercom",
	displayName: "Intercom",
	statusPageUrl: "https://www.intercomstatus.com",
	statusPageApiUrl: "https://www.intercomstatus.com/api/v2/summary.json",
	statusPagePolling: true,
	affectedFeatures: [],
	dataConnectionProvider: "INTERCOM",
});

registerIntegrationProvider({
	key: "github",
	displayName: "GitHub",
	statusPageUrl: "https://www.githubstatus.com",
	statusPageApiUrl: "https://www.githubstatus.com/api/v2/summary.json",
	statusPagePolling: true,
	affectedFeatures: ["pm_sync"],
	dataConnectionProvider: "GITHUB",
});

registerIntegrationProvider({
	key: "gitlab",
	displayName: "GitLab",
	statusPageUrl: "https://status.gitlab.com",
	// GitLab self-hosts on status.io (NOT Atlassian Statuspage). The API
	// returns `{result: {status_overall, status, incidents, maintenance}}`.
	// The page id is embedded in their dashboard HTML.
	statusPageApiUrl:
		"https://api.status.io/1.0/status/5b36dc6502d06804c08349f7",
	statusPagePolling: true,
	customParser: "status-io",
	affectedFeatures: [],
	dataConnectionProvider: "GITLAB",
});

registerIntegrationProvider({
	key: "bitbucket",
	displayName: "Bitbucket",
	statusPageUrl: "https://bitbucket.status.atlassian.com",
	statusPageApiUrl:
		"https://bitbucket.status.atlassian.com/api/v2/summary.json",
	statusPagePolling: true,
	affectedFeatures: [],
	dataConnectionProvider: "BITBUCKET",
});

registerIntegrationProvider({
	key: "linear",
	displayName: "Linear",
	// Linear migrated from Atlassian Statuspage to incident.io. The old
	// `status.linear.app` 301s; the new host serves the same Atlassian-
	// compatible JSON shape so the default parser handles it.
	statusPageUrl: "https://linearstatus.com",
	statusPageApiUrl: "https://linearstatus.com/api/v2/summary.json",
	statusPagePolling: true,
	affectedFeatures: ["pm_sync"],
	dataConnectionProvider: "LINEAR",
});

registerIntegrationProvider({
	key: "asana",
	displayName: "Asana",
	statusPageUrl: "https://status.asana.com",
	statusPageApiUrl: "https://status.asana.com/api/v2/summary.json",
	statusPagePolling: true,
	affectedFeatures: ["pm_sync"],
	dataConnectionProvider: "ASANA",
});

registerIntegrationProvider({
	key: "clickup",
	displayName: "ClickUp",
	statusPageUrl: "https://status.clickup.com",
	// ClickUp self-hosts on status.io (NOT Atlassian Statuspage). The
	// page id is embedded in their dashboard HTML.
	statusPageApiUrl:
		"https://api.status.io/1.0/status/5b6e0963c662144d00913a09",
	statusPagePolling: true,
	customParser: "status-io",
	affectedFeatures: ["pm_sync"],
	dataConnectionProvider: "CLICKUP",
});

registerIntegrationProvider({
	key: "slack",
	displayName: "Slack",
	statusPageUrl: "https://status.slack.com",
	// Slack's v2 status API returns `{status, active_incidents: [...]}`
	// (NOT Atlassian Statuspage shape).
	statusPageApiUrl: "https://status.slack.com/api/v2.0.0/current",
	statusPagePolling: true,
	customParser: "slack",
	affectedFeatures: [],
	dataConnectionProvider: "SLACK",
});

registerIntegrationProvider({
	key: "snowflake",
	displayName: "Snowflake",
	statusPageUrl: "https://status.snowflake.com",
	statusPageApiUrl: "https://status.snowflake.com/api/v2/summary.json",
	statusPagePolling: true,
	affectedFeatures: [],
	dataConnectionProvider: "SNOWFLAKE",
});

registerIntegrationProvider({
	key: "bigquery",
	displayName: "BigQuery",
	statusPageUrl: "https://status.cloud.google.com",
	statusPageApiUrl: "https://status.cloud.google.com/incidents.json",
	statusPagePolling: true,
	customParser: "google-cloud",
	googleCloudProductTitle: "BigQuery",
	affectedFeatures: [],
	dataConnectionProvider: "BIGQUERY",
});

registerIntegrationProvider({
	key: "zendesk",
	displayName: "Zendesk",
	statusPageUrl: "https://status.zendesk.com",
	// Zendesk runs a custom status portal (NOT Atlassian Statuspage). The
	// `summary.json` endpoint returns 404; the SPA fetches a JSON:API-
	// shaped incidents list under `/api/ssp/incidents.json`.
	statusPageApiUrl: "https://status.zendesk.com/api/ssp/incidents.json",
	statusPagePolling: true,
	customParser: "zendesk-ssp",
	affectedFeatures: [],
	dataConnectionProvider: "ZENDESK",
});

registerIntegrationProvider({
	key: "gong",
	displayName: "Gong",
	// Gong migrated to incident.io. The new endpoint serves the same
	// Atlassian-compatible JSON shape so the default parser handles it.
	statusPageUrl: "https://status.gong.io",
	statusPageApiUrl: "https://status.gong.io/api/v2/summary.json",
	statusPagePolling: true,
	affectedFeatures: [],
	dataConnectionProvider: "GONG",
});

registerIntegrationProvider({
	key: "gmail",
	displayName: "Gmail",
	statusPageUrl: "https://www.google.com/appsstatus/dashboard/",
	// Gmail health is published on the Google Workspace Status Dashboard
	// (same feed as Google Drive). The `google-workspace` parser narrows
	// the incident list to a single product by `service_name`.
	statusPageApiUrl:
		"https://www.google.com/appsstatus/dashboard/incidents.json",
	statusPagePolling: true,
	customParser: "google-workspace",
	googleWorkspaceServiceName: "Gmail",
	affectedFeatures: [],
	dataConnectionProvider: "GMAIL",
});

registerIntegrationProvider({
	key: "jira",
	displayName: "Jira",
	statusPageUrl: "https://jira-software.status.atlassian.com",
	statusPageApiUrl:
		"https://jira-software.status.atlassian.com/api/v2/summary.json",
	statusPagePolling: true,
	affectedFeatures: ["pm_sync"],
	dataConnectionProvider: "JIRA",
});

registerIntegrationProvider({
	key: "microsoft_365",
	displayName: "Microsoft 365",
	statusPageUrl: "https://portal.office.com/servicestatus",
	// Requires Microsoft Graph + admin auth
	statusPagePolling: false,
	statusUnsupportedReason:
		"Microsoft Service Health requires authenticated admin access",
	affectedFeatures: [],
	dataConnectionProvider: "MICROSOFT_365",
});

registerIntegrationProvider({
	key: "salesforce",
	displayName: "Salesforce",
	statusPageUrl: "https://status.salesforce.com",
	// Salesforce Trust v1 exposes a public `/v1/incidents/active` JSON
	// endpoint returning an array of currently-active incidents (NOT the
	// Atlassian Statuspage shape). Empty array = OPERATIONAL.
	statusPageApiUrl: "https://api.status.salesforce.com/v1/incidents/active",
	statusPagePolling: true,
	customParser: "salesforce",
	affectedFeatures: [],
	dataConnectionProvider: "SALESFORCE",
});

registerIntegrationProvider({
	key: "hubspot",
	displayName: "HubSpot",
	statusPageUrl: "https://status.hubspot.com",
	statusPageApiUrl: "https://status.hubspot.com/api/v2/summary.json",
	statusPagePolling: true,
	affectedFeatures: [],
	dataConnectionProvider: "HUBSPOT",
});
