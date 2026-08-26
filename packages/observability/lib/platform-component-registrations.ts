/**
 * Concrete platform-component registrations — imported for side effects by
 * `@repo/observability`'s entry point, the same way
 * `integration-providers.ts` is.
 *
 * Six entries. Each one names a signal that already exists in Postgres; none
 * of them requires new instrumentation. A seventh component would need a
 * seventh real signal — please do not add one that resolves to a constant,
 * because a permanent green is indistinguishable from "we never checked".
 *
 * Copy discipline: `displayName` and `description` are read by customers.
 * Name the capability they recognise, never the implementation. "Background
 * processing", not the workflow engine's name.
 */

import { registerPlatformComponent } from "./platform-components";

registerPlatformComponent({
	key: "core-api",
	displayName: "Application & API",
	description:
		"Signing in, loading pages, and reading or saving your work in the app and over the API.",
	group: "CORE",
	// Thresholds are per-tenant over 15 minutes. A handful of server faults in
	// that window is normal background noise on any busy workspace; ten is a
	// pattern worth telling the customer about.
	signal: {
		kind: "tenant-server-faults",
		windowMinutes: 15,
		degradedAt: 5,
		outageAt: 20,
	},
	incidentKeys: ["core-api", "web", "api", "prisma-drift"],
	displayOrder: 10,
});

registerPlatformComponent({
	key: "background-jobs",
	displayName: "Background processing",
	description:
		"Scheduled and long-running work: syncs, analysis runs, scans, and report generation.",
	group: "AUTOMATION",
	// The status-page poller writes `lastPolledAt` every 2 minutes. Ten minutes
	// without a write is four missed ticks — a real stall rather than a slow
	// tick. Thirty minutes means we can no longer claim to know anything, so
	// the component reports UNKNOWN instead of guessing.
	signal: {
		kind: "background-work-freshness",
		degradedAfterMinutes: 10,
		staleAfterMinutes: 30,
	},
	incidentKeys: ["temporal-worker", "background-jobs", "rag-indexer"],
	displayOrder: 20,
});

registerPlatformComponent({
	key: "ai-generation",
	displayName: "AI generation",
	description:
		"Drafting, summarising, and any other feature that asks a language model for output.",
	group: "AI",
	signal: { kind: "provider-rollup", providerKeys: ["openai", "anthropic"] },
	incidentKeys: ["agent-rail", "ai-generation"],
	displayOrder: 30,
});

registerPlatformComponent({
	key: "integrations",
	displayName: "Integration sync",
	description:
		"Keeping your connected tools in step — issue trackers, repositories, docs, and chat.",
	group: "INTEGRATIONS",
	signal: { kind: "tenant-connections" },
	incidentKeys: ["integrations", "pm-sync"],
	displayOrder: 40,
});

registerPlatformComponent({
	key: "file-storage",
	displayName: "File storage",
	description:
		"Uploading, storing, and downloading attachments and documents.",
	group: "DATA",
	signal: { kind: "provider-rollup", providerKeys: ["aws_s3"] },
	incidentKeys: ["file-storage", "storage"],
	displayOrder: 50,
});

registerPlatformComponent({
	key: "email-delivery",
	displayName: "Email delivery",
	description:
		"Sign-in links, invitations, and notification emails leaving the platform.",
	group: "CORE",
	signal: { kind: "provider-rollup", providerKeys: ["resend"] },
	incidentKeys: ["email-delivery", "email"],
	displayOrder: 60,
});
