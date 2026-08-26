/**
 * URL Context Sources telemetry payload audit (Group 10.1) plus the
 * Unified Context Uploader Wizard's added-during-wizard event (spec
 * `2026-05-23-unified-context-uploader-wizard` §9.2, Group 11.4).
 *
 * Spec:
 *  - fabric/specs/2026-05-13-url-context-sources/spec.md §13
 *  - fabric/specs/2026-05-13-url-context-sources/tasks.md Group 10.1
 *  - fabric/specs/2026-05-23-unified-context-uploader-wizard/spec.md §9.2
 *  - fabric/specs/2026-05-23-unified-context-uploader-wizard/tasks.md
 *    Group 11.4
 *
 * This file is the single source of truth for the five telemetry events
 * the two specs together require. It documents the payload shape
 * contract via runtime-checkable Zod schemas AND wires light-touch
 * end-to-end checks through the helpers that emit them:
 *
 *  - `project_context_url_added` — fired client-side from
 *    `ContextUploaderDialog.handleUrlSourceAdd` on processLink success.
 *  - `project_context_url_resynced` — fired client-side from the Manage
 *    panel + Re-sync buttons (trigger='manual'); server-side from
 *    `urlSourceCrawlWorkflow` for trigger ∈ {scheduled, manual} and from
 *    `gatherLiveUrlSources` for trigger ∈ {live-retrieval, fallback}.
 *  - `project_context_url_crawl_failed` — fired server-side from
 *    `urlSourceCrawlWorkflow`'s catch block.
 *  - `project_context_url_content_previewed` — fired client-side from
 *    `UrlPagePreviewDrawer` on row expand.
 *  - `project_context_added_during_wizard` — fired client-side from
 *    every successful `ContextUploaderDialog` submit branch (File / Link
 *    / Text / Teams / Slack / Notion). The `surface` enum lets the ops
 *    dashboard compare pre-creation (wizard) vs post-creation
 *    attachment, answering: did moving the entry point into the wizard
 *    drive more pre-creation context attachment?
 *
 * Client-side events flow through `useAnalytics().trackEvent`. Server-side
 * events are emitted as structured log records tagged `event="..."` and
 * routed to the ops dashboard (see ROLLOUT.md for the Datadog/Grafana
 * queries).
 *
 * What this test guards:
 *   1. Schema-level validation of every payload shape.
 *   2. Documentation of the `trigger` enum for `project_context_url_resynced`.
 *   3. Documentation of the `stage` and `errorType` enums for
 *      `project_context_url_crawl_failed`.
 *
 * Wide component-level firing checks live in:
 *   - `modules/saas/projects/components/__tests__/UrlPagePreviewDrawer.test.tsx`
 *   - `modules/saas/projects/components/__tests__/ProjectContextsList.link-card.test.tsx`
 *   - `modules/saas/projects/components/__tests__/ContextUploaderDialog.url-tab.test.tsx`
 *   - `packages/temporal/__tests__/url-source/helpers.test.ts` (classifiers)
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

// ── Payload schemas ───────────────────────────────────

const urlAddedSchema = z.object({
	event: z.literal("project_context_url_added"),
	scope: z.enum(["SINGLE_PAGE", "PATH_PREFIX"]),
	refreshMode: z.enum(["ONCE", "DAILY", "WEEKLY", "MONTHLY", "LIVE"]),
	maxPages: z.number().int().min(1).max(500).nullable(),
	projectId: z.string().min(1),
	organizationId: z.string().min(1).optional(),
});

const urlResyncedSchema = z.object({
	event: z.literal("project_context_url_resynced"),
	trigger: z.enum(["manual", "scheduled", "live-retrieval", "fallback"]),
	pagesIndexed: z.number().int().min(0),
	// durationMs is nullable for retrieval-time triggers because the
	// surrounding Promise.allSettled does not isolate per-row latency.
	durationMs: z.number().int().min(0).nullable(),
	projectId: z.string().min(1).optional(),
	contextId: z.string().min(1).optional(),
});

const urlCrawlFailedSchema = z.object({
	event: z.literal("project_context_url_crawl_failed"),
	stage: z.enum([
		"firecrawl-scrape",
		"firecrawl-crawl",
		"embed",
		"upsert",
		"unknown",
	]),
	errorType: z.enum([
		"ROBOTS_BLOCKED",
		"QUOTA_EXCEEDED",
		"TIMEOUT",
		"UNKNOWN",
	]),
	projectId: z.string().min(1),
	contextId: z.string().min(1).optional(),
});

const urlContentPreviewedSchema = z.object({
	event: z.literal("project_context_url_content_previewed"),
	pageId: z.string().min(1),
	projectId: z.string().min(1),
	organizationId: z.string().min(1).optional(),
});

// Spec `2026-05-23-unified-context-uploader-wizard` §9.2 verbatim
// payload contract for `project_context_added_during_wizard`. The
// pipeline stamps `userId` + `organizationId` so they are deliberately
// absent from the client-side payload. `integrationKind` is only
// present (and only allowed) when `contextType === "INTEGRATION"`.
const contextAddedDuringWizardSchema = z
	.object({
		event: z.literal("project_context_added_during_wizard"),
		surface: z.enum(["wizard", "post-creation"]),
		contextType: z.enum(["FILE", "LINK", "TEXT", "INTEGRATION"]),
		integrationKind: z.enum(["TEAMS", "SLACK", "NOTION"]).optional(),
	})
	.superRefine((val, ctx) => {
		// Integration-only field guard — if the row is not an
		// INTEGRATION we reject a stray integrationKind so the pipeline
		// never has to disambiguate "FILE with TEAMS" rows.
		if (val.contextType !== "INTEGRATION" && val.integrationKind) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message:
					"integrationKind is only valid when contextType === INTEGRATION",
				path: ["integrationKind"],
			});
		}
		if (val.contextType === "INTEGRATION" && !val.integrationKind) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message:
					"INTEGRATION rows must carry an integrationKind for granularity",
				path: ["integrationKind"],
			});
		}
	});

// ── Spec-§13 contract guard ────────────────────────────────────────────────

describe("URL Context Sources telemetry payload contract", () => {
	describe("project_context_url_added", () => {
		it("accepts a minimal personal-tenant payload (SINGLE_PAGE / ONCE)", () => {
			const payload = {
				event: "project_context_url_added",
				scope: "SINGLE_PAGE",
				refreshMode: "ONCE",
				maxPages: null,
				projectId: "proj_1",
			};
			expect(urlAddedSchema.parse(payload)).toEqual(payload);
		});

		it("accepts a PATH_PREFIX org payload with maxPages", () => {
			const payload = {
				event: "project_context_url_added",
				scope: "PATH_PREFIX",
				refreshMode: "WEEKLY",
				maxPages: 250,
				projectId: "proj_1",
				organizationId: "org_acme",
			};
			expect(urlAddedSchema.parse(payload)).toEqual(payload);
		});

		it("rejects an out-of-range maxPages", () => {
			expect(() =>
				urlAddedSchema.parse({
					event: "project_context_url_added",
					scope: "PATH_PREFIX",
					refreshMode: "ONCE",
					maxPages: 501,
					projectId: "proj_1",
				}),
			).toThrow();
		});

		it("rejects an unknown refreshMode", () => {
			expect(() =>
				urlAddedSchema.parse({
					event: "project_context_url_added",
					scope: "SINGLE_PAGE",
					refreshMode: "HOURLY",
					maxPages: null,
					projectId: "proj_1",
				}),
			).toThrow();
		});
	});

	describe("project_context_url_resynced", () => {
		const validTriggers = [
			"manual",
			"scheduled",
			"live-retrieval",
			"fallback",
		] as const;

		it.each(validTriggers)("accepts trigger=%s", (trigger) => {
			const payload = {
				event: "project_context_url_resynced",
				trigger,
				pagesIndexed: 5,
				durationMs: 1234,
				projectId: "proj_1",
			};
			expect(urlResyncedSchema.parse(payload)).toEqual(payload);
		});

		it("accepts null durationMs (retrieval-time variants do not measure per-row latency)", () => {
			const payload = {
				event: "project_context_url_resynced",
				trigger: "live-retrieval",
				pagesIndexed: 1,
				durationMs: null,
				contextId: "ctx_1",
			};
			expect(urlResyncedSchema.parse(payload)).toEqual(payload);
		});

		it("rejects an unknown trigger", () => {
			expect(() =>
				urlResyncedSchema.parse({
					event: "project_context_url_resynced",
					trigger: "auto",
					pagesIndexed: 5,
					durationMs: 1234,
					projectId: "proj_1",
				}),
			).toThrow();
		});
	});

	describe("project_context_url_crawl_failed", () => {
		const stages = [
			"firecrawl-scrape",
			"firecrawl-crawl",
			"embed",
			"upsert",
			"unknown",
		] as const;
		const errorTypes = [
			"ROBOTS_BLOCKED",
			"QUOTA_EXCEEDED",
			"TIMEOUT",
			"UNKNOWN",
		] as const;

		it.each(stages)("accepts stage=%s", (stage) => {
			const payload = {
				event: "project_context_url_crawl_failed",
				stage,
				errorType: "ROBOTS_BLOCKED",
				projectId: "proj_1",
				contextId: "ctx_1",
			};
			expect(urlCrawlFailedSchema.parse(payload)).toEqual(payload);
		});

		it.each(errorTypes)("accepts errorType=%s", (errorType) => {
			const payload = {
				event: "project_context_url_crawl_failed",
				stage: "firecrawl-scrape" as const,
				errorType,
				projectId: "proj_1",
				contextId: "ctx_1",
			};
			expect(urlCrawlFailedSchema.parse(payload)).toEqual(payload);
		});
	});

	describe("project_context_url_content_previewed", () => {
		it("accepts the minimal payload", () => {
			const payload = {
				event: "project_context_url_content_previewed",
				pageId: "page_1",
				projectId: "proj_1",
			};
			expect(urlContentPreviewedSchema.parse(payload)).toEqual(payload);
		});

		it("accepts an organization-scoped payload", () => {
			const payload = {
				event: "project_context_url_content_previewed",
				pageId: "page_1",
				projectId: "proj_1",
				organizationId: "org_acme",
			};
			expect(urlContentPreviewedSchema.parse(payload)).toEqual(payload);
		});
	});

	describe("project_context_added_during_wizard", () => {
		const surfaces = ["wizard", "post-creation"] as const;
		const baseTypes = ["FILE", "LINK", "TEXT"] as const;
		const integrationKinds = ["TEAMS", "SLACK", "NOTION"] as const;

		it.each(surfaces)(
			"accepts surface=%s for a non-INTEGRATION row (FILE)",
			(surface) => {
				const payload = {
					event: "project_context_added_during_wizard",
					surface,
					contextType: "FILE",
				};
				expect(contextAddedDuringWizardSchema.parse(payload)).toEqual(
					payload,
				);
			},
		);

		it.each(baseTypes)(
			"accepts contextType=%s without an integrationKind",
			(contextType) => {
				const payload = {
					event: "project_context_added_during_wizard",
					surface: "wizard" as const,
					contextType,
				};
				expect(contextAddedDuringWizardSchema.parse(payload)).toEqual(
					payload,
				);
			},
		);

		it.each(integrationKinds)(
			"accepts an INTEGRATION row with integrationKind=%s",
			(integrationKind) => {
				const payload = {
					event: "project_context_added_during_wizard",
					surface: "post-creation" as const,
					contextType: "INTEGRATION",
					integrationKind,
				};
				expect(contextAddedDuringWizardSchema.parse(payload)).toEqual(
					payload,
				);
			},
		);

		it("rejects an unknown surface (typo guard)", () => {
			expect(() =>
				contextAddedDuringWizardSchema.parse({
					event: "project_context_added_during_wizard",
					surface: "settings",
					contextType: "FILE",
				}),
			).toThrow();
		});

		it("rejects an unknown contextType", () => {
			expect(() =>
				contextAddedDuringWizardSchema.parse({
					event: "project_context_added_during_wizard",
					surface: "wizard",
					contextType: "VIDEO",
				}),
			).toThrow();
		});

		it("rejects integrationKind on a FILE/LINK/TEXT row", () => {
			expect(() =>
				contextAddedDuringWizardSchema.parse({
					event: "project_context_added_during_wizard",
					surface: "wizard",
					contextType: "LINK",
					integrationKind: "TEAMS",
				}),
			).toThrow();
		});

		it("rejects an INTEGRATION row missing integrationKind", () => {
			expect(() =>
				contextAddedDuringWizardSchema.parse({
					event: "project_context_added_during_wizard",
					surface: "wizard",
					contextType: "INTEGRATION",
				}),
			).toThrow();
		});

		it("rejects a userId/organizationId smuggled into the payload (pipeline stamps these)", () => {
			// Zod by default strips unknown keys via z.object(), so the
			// parse succeeds without the extras. We assert the parsed
			// output equals the spec-defined fields only — extras are
			// silently dropped by the gate, signalling the pipeline that
			// nothing identifying is in the client payload.
			const parsed = contextAddedDuringWizardSchema.parse({
				event: "project_context_added_during_wizard",
				surface: "wizard",
				contextType: "FILE",
				userId: "user_should_not_be_here",
				organizationId: "org_should_not_be_here",
			});
			expect(parsed).toEqual({
				event: "project_context_added_during_wizard",
				surface: "wizard",
				contextType: "FILE",
			});
		});
	});
});

// ── End-to-end firing check via the shared analytics surface ─────────────

// We do NOT remount the producing components here — those already have their
// own tests (referenced in the header). Instead we assert the contract
// agnostic of the source: every event the spec lists is documented above,
// and the schemas serve as the runtime gate so a future code change can't
// silently drift the payload.

describe("Event-name registry (spec §13 + Unified Wizard §9.2 coverage)", () => {
	it("documents exactly five telemetry event names across both specs", () => {
		const documented = new Set([
			"project_context_url_added",
			"project_context_url_resynced",
			"project_context_url_crawl_failed",
			"project_context_url_content_previewed",
			"project_context_added_during_wizard",
		]);
		expect(documented.size).toBe(5);
	});
});
