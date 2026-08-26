/**
 * Tests for `pollStatusPage` activity.
 *
 * Covers the four error cases (timeout, 4xx, 5xx, network), the default
 * Atlassian Statuspage path, and every `customParser` discriminator —
 * Google Workspace, Google Cloud, Slack, status.io, and Zendesk SSP.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pollStatusPage } from "../poll-status-page";

const PROVIDER = {
	providerKey: "openai",
	url: "https://status.openai.com/api/v2/summary.json",
};

beforeEach(() => {
	vi.restoreAllMocks();
});

afterEach(() => {
	vi.useRealTimers();
});

/**
 * Build a `Response`-shaped mock with sensible defaults. Vitest's default
 * unhandled-thenable equality is happy with this — it never touches the
 * real `Response` constructor (which would require Web platform shims).
 */
function mockFetch(response: Partial<Response>) {
	const merged: Partial<Response> = {
		ok: response.ok ?? true,
		status: response.status ?? 200,
		headers:
			response.headers ??
			new Headers({ "content-type": "application/json" }),
		...response,
	};
	return vi.spyOn(global, "fetch").mockResolvedValueOnce(merged as Response);
}

describe("pollStatusPage", () => {
	describe("operational path", () => {
		it("maps 'none' indicator to OPERATIONAL + shouldCloseExisting=true", async () => {
			mockFetch({
				ok: true,
				json: async () => ({
					status: {
						indicator: "none",
						description: "All Systems Operational",
					},
					incidents: [],
				}),
			});
			const result = await pollStatusPage(PROVIDER);
			expect(result.health).toBe("OPERATIONAL");
			expect(result.shouldCloseExisting).toBe(true);
			expect(result.openIncident).toBeNull();
			expect(result.severity).toBe("SEV2");
		});
	});

	describe("incident path", () => {
		it("returns an open incident when indicator is major and there is a live incident", async () => {
			mockFetch({
				ok: true,
				json: async () => ({
					status: {
						indicator: "major",
						description: "Partial Outage",
					},
					incidents: [
						{
							id: "inc-abc-123",
							name: "Chat completions degraded",
							status: "monitoring",
							components: [{ name: "API" }, { name: "ChatGPT" }],
						},
					],
				}),
			});
			const result = await pollStatusPage(PROVIDER);
			expect(result.health).toBe("PARTIAL_OUTAGE");
			expect(result.severity).toBe("SEV2");
			expect(result.openIncident).toEqual({
				id: "inc-abc-123",
				name: "Chat completions degraded",
				affectedComponents: ["API", "ChatGPT"],
			});
			expect(result.shouldCloseExisting).toBe(false);
		});

		it("maps 'critical' indicator to MAJOR_OUTAGE with SEV1", async () => {
			mockFetch({
				ok: true,
				json: async () => ({
					status: { indicator: "critical" },
					incidents: [
						{ id: "x", name: "down", status: "investigating" },
					],
				}),
			});
			const result = await pollStatusPage(PROVIDER);
			expect(result.health).toBe("MAJOR_OUTAGE");
			expect(result.severity).toBe("SEV1");
			expect(result.openIncident).not.toBeNull();
		});

		it("skips resolved incidents when finding the live one", async () => {
			mockFetch({
				ok: true,
				json: async () => ({
					status: { indicator: "minor" },
					incidents: [
						{ id: "old", name: "fixed", status: "resolved" },
						{ id: "new", name: "active", status: "monitoring" },
					],
				}),
			});
			const result = await pollStatusPage(PROVIDER);
			expect(result.openIncident?.id).toBe("new");
		});
	});

	describe("error cases", () => {
		it("returns UNKNOWN on 4xx HTTP response", async () => {
			mockFetch({ ok: false, status: 404, statusText: "Not Found" });
			const result = await pollStatusPage(PROVIDER);
			expect(result.health).toBe("UNKNOWN");
			expect(result.openIncident).toBeNull();
			expect(result.shouldCloseExisting).toBe(false);
		});

		it("returns UNKNOWN on 5xx HTTP response", async () => {
			mockFetch({
				ok: false,
				status: 503,
				statusText: "Service Unavailable",
			});
			const result = await pollStatusPage(PROVIDER);
			expect(result.health).toBe("UNKNOWN");
		});

		it("returns UNKNOWN on network failure", async () => {
			vi.spyOn(global, "fetch").mockRejectedValueOnce(
				new Error("ECONNREFUSED"),
			);
			const result = await pollStatusPage(PROVIDER);
			expect(result.health).toBe("UNKNOWN");
		});

		it("returns UNKNOWN on malformed JSON", async () => {
			mockFetch({
				ok: true,
				json: async () => {
					throw new Error("Unexpected token");
				},
			});
			const result = await pollStatusPage(PROVIDER);
			expect(result.health).toBe("UNKNOWN");
		});

		it("returns UNKNOWN on unknown indicator string", async () => {
			mockFetch({
				ok: true,
				json: async () => ({
					status: { indicator: "lava-rain" },
					incidents: [],
				}),
			});
			const result = await pollStatusPage(PROVIDER);
			expect(result.health).toBe("UNKNOWN");
			expect(result.shouldCloseExisting).toBe(false);
		});

		it("returns UNKNOWN on missing status indicator", async () => {
			mockFetch({ ok: true, json: async () => ({}) });
			const result = await pollStatusPage(PROVIDER);
			expect(result.health).toBe("UNKNOWN");
		});
	});

	describe("maintenance window", () => {
		it("maps 'maintenance' indicator to MAINTENANCE", async () => {
			mockFetch({
				ok: true,
				json: async () => ({
					status: { indicator: "maintenance" },
					incidents: [],
				}),
			});
			const result = await pollStatusPage(PROVIDER);
			expect(result.health).toBe("MAINTENANCE");
			expect(result.shouldCloseExisting).toBe(false);
		});
	});

	describe("request headers", () => {
		it("sends User-Agent and Accept JSON headers on every poll", async () => {
			const fetchSpy = mockFetch({
				ok: true,
				json: async () => ({
					status: { indicator: "none" },
					incidents: [],
				}),
			});
			await pollStatusPage(PROVIDER);
			expect(fetchSpy).toHaveBeenCalledTimes(1);
			const init = fetchSpy.mock.calls[0]?.[1];
			const headers = init?.headers as Record<string, string> | undefined;
			expect(headers?.["User-Agent"]).toBe(
				"Fabric-Monitoring/1.0 (+https://fabric.pro/status)",
			);
			expect(headers?.Accept).toBe("application/json");
		});

		it("returns UNKNOWN when the response 429s (Retry-After path)", async () => {
			mockFetch({
				ok: false,
				status: 429,
				headers: new Headers({ "retry-after": "30" }),
			});
			const result = await pollStatusPage(PROVIDER);
			expect(result.health).toBe("UNKNOWN");
			expect(result.shouldCloseExisting).toBe(false);
		});

		it("returns UNKNOWN when content-type is not JSON (HTML SPA case)", async () => {
			mockFetch({
				ok: true,
				headers: new Headers({ "content-type": "text/html" }),
				json: async () => ({
					status: { indicator: "none" },
				}),
			});
			const result = await pollStatusPage(PROVIDER);
			expect(result.health).toBe("UNKNOWN");
		});
	});
});

// ---------------------------------------------------------------------------
// Atlassian component filter (Cloudflare R2 use case)
// ---------------------------------------------------------------------------

describe("pollStatusPage — statusPageComponents filter on Atlassian parser", () => {
	// Real-world bug: Cloudflare's statuspage at
	// www.cloudflarestatus.com/api/v2/summary.json returns incidents
	// for the whole Cloudflare platform — Workers, R2, Pages, Billing.
	// Without filtering, a Billing incident shows up as a "Cloudflare R2"
	// outage in our admin UI, which is misleading.
	const R2_INPUT = {
		providerKey: "r2",
		url: "https://www.cloudflarestatus.com/api/v2/summary.json",
		statusPageComponents: ["R2", "R2 Object Storage"],
	};

	it("ignores incidents whose components do NOT match the filter (Cloudflare Billing → OPERATIONAL for R2)", async () => {
		mockFetch({
			ok: true,
			json: async () => ({
				status: { indicator: "minor", description: "Partial Outage" },
				incidents: [
					{
						id: "billing-incident-1",
						name: "PayPal Billing Issues",
						status: "monitoring",
						components: [
							{ name: "Cloudflare Billing" },
							{ name: "Stream Subscriptions" },
						],
					},
				],
			}),
		});
		const result = await pollStatusPage(R2_INPUT);
		// The page indicator says "minor" but the only listed incident
		// touches Billing — for the R2 provider, our health is OPERATIONAL.
		expect(result.health).toBe("OPERATIONAL");
		expect(result.openIncident).toBeNull();
		expect(result.shouldCloseExisting).toBe(true);
	});

	it("treats an R2-component incident as a real R2 outage", async () => {
		mockFetch({
			ok: true,
			json: async () => ({
				status: { indicator: "major", description: "Partial Outage" },
				incidents: [
					{
						id: "r2-incident-1",
						name: "Increased error rate on R2 reads",
						status: "investigating",
						components: [{ name: "R2" }],
					},
				],
			}),
		});
		const result = await pollStatusPage(R2_INPUT);
		expect(result.health).toBe("PARTIAL_OUTAGE");
		expect(result.openIncident?.id).toBe("r2-incident-1");
	});

	it("matches the older 'R2 Object Storage' component alias case-insensitively", async () => {
		// Cloudflare has renamed R2 historically — both names are
		// registered defensively so a future rename doesn't silently
		// drop the signal.
		mockFetch({
			ok: true,
			json: async () => ({
				status: { indicator: "major" },
				incidents: [
					{
						id: "r2-incident-2",
						name: "R2 Object Storage degraded",
						status: "monitoring",
						components: [{ name: "r2 OBJECT STORAGE" }],
					},
				],
			}),
		});
		const result = await pollStatusPage(R2_INPUT);
		expect(result.health).toBe("PARTIAL_OUTAGE");
		expect(result.openIncident?.id).toBe("r2-incident-2");
	});

	it("picks the R2 incident from a list that includes both R2 and non-R2 incidents", async () => {
		mockFetch({
			ok: true,
			json: async () => ({
				status: { indicator: "major" },
				incidents: [
					{
						id: "billing-1",
						name: "Billing slowness",
						status: "investigating",
						components: [{ name: "Cloudflare Billing" }],
					},
					{
						id: "r2-1",
						name: "R2 reads degraded",
						status: "investigating",
						components: [{ name: "R2" }],
					},
				],
			}),
		});
		const result = await pollStatusPage(R2_INPUT);
		expect(result.openIncident?.id).toBe("r2-1");
	});

	it("with no component filter, ALL incidents are considered (default behavior preserved)", async () => {
		const NO_FILTER_INPUT = {
			providerKey: "cloudflare-all",
			url: "https://www.cloudflarestatus.com/api/v2/summary.json",
			// no statusPageComponents
		};
		mockFetch({
			ok: true,
			json: async () => ({
				status: { indicator: "minor" },
				incidents: [
					{
						id: "billing-incident-2",
						name: "PayPal Billing Issues",
						status: "monitoring",
						components: [{ name: "Cloudflare Billing" }],
					},
				],
			}),
		});
		const result = await pollStatusPage(NO_FILTER_INPUT);
		// No filter — the Billing incident still surfaces.
		expect(result.health).toBe("DEGRADED");
		expect(result.openIncident?.id).toBe("billing-incident-2");
	});

	it("treats an empty statusPageComponents array the same as no filter", async () => {
		mockFetch({
			ok: true,
			json: async () => ({
				status: { indicator: "minor" },
				incidents: [
					{
						id: "incident-1",
						name: "Some incident",
						status: "investigating",
						components: [{ name: "Workers" }],
					},
				],
			}),
		});
		const result = await pollStatusPage({
			...R2_INPUT,
			statusPageComponents: [],
		});
		// Empty array → no filtering → the Workers incident surfaces.
		expect(result.health).toBe("DEGRADED");
		expect(result.openIncident?.id).toBe("incident-1");
	});
});

// ---------------------------------------------------------------------------
// Custom parser dispatch — non-Atlassian providers
// ---------------------------------------------------------------------------

describe("pollStatusPage — google-workspace custom parser", () => {
	const GMAIL_INPUT = {
		providerKey: "gmail",
		url: "https://www.google.com/appsstatus/dashboard/incidents.json",
		customParser: "google-workspace" as const,
		googleWorkspaceServiceName: "Gmail",
	};

	it("returns OPERATIONAL when no active Gmail incident exists", async () => {
		mockFetch({
			ok: true,
			json: async () => [
				{
					id: "old-1",
					service_name: "Gmail",
					begin: "2026-01-01T00:00:00+00:00",
					end: "2026-01-02T00:00:00+00:00",
					status_impact: "SERVICE_OUTAGE",
				},
				{
					id: "other-1",
					service_name: "Google Drive",
					begin: "2099-01-01T00:00:00+00:00",
					end: null,
					status_impact: "SERVICE_OUTAGE",
				},
			],
		});
		const result = await pollStatusPage(GMAIL_INPUT);
		expect(result.health).toBe("OPERATIONAL");
		expect(result.shouldCloseExisting).toBe(true);
	});

	it("maps SERVICE_DISRUPTION on a matching service to PARTIAL_OUTAGE", async () => {
		mockFetch({
			ok: true,
			json: async () => [
				{
					id: "gmail-1",
					service_name: "Gmail",
					begin: "2099-01-01T00:00:00+00:00",
					end: null,
					status_impact: "SERVICE_DISRUPTION",
					external_desc: "Some users may be unable to send",
					most_recent_update: {
						status: "AVAILABLE",
						text: "Investigating elevated send errors",
					},
					affected_products: [{ title: "Gmail" }],
				},
			],
		});
		const result = await pollStatusPage(GMAIL_INPUT);
		expect(result.health).toBe("PARTIAL_OUTAGE");
		expect(result.openIncident?.id).toBe("gmail-1");
		expect(result.openIncident?.affectedComponents).toEqual(["Gmail"]);
	});

	it("maps SERVICE_OUTAGE on a matching service to MAJOR_OUTAGE + SEV1", async () => {
		mockFetch({
			ok: true,
			json: async () => [
				{
					id: "gmail-2",
					service_name: "Gmail",
					begin: "2099-01-01T00:00:00+00:00",
					end: null,
					status_impact: "SERVICE_OUTAGE",
				},
			],
		});
		const result = await pollStatusPage(GMAIL_INPUT);
		expect(result.health).toBe("MAJOR_OUTAGE");
		expect(result.severity).toBe("SEV1");
	});

	it("ignores incidents for other services", async () => {
		mockFetch({
			ok: true,
			json: async () => [
				{
					id: "drive-1",
					service_name: "Google Drive",
					begin: "2099-01-01T00:00:00+00:00",
					end: null,
					status_impact: "SERVICE_OUTAGE",
				},
			],
		});
		const result = await pollStatusPage(GMAIL_INPUT);
		expect(result.health).toBe("OPERATIONAL");
	});

	it("returns UNKNOWN when the response is not an array", async () => {
		mockFetch({ ok: true, json: async () => ({ not: "an array" }) });
		const result = await pollStatusPage(GMAIL_INPUT);
		expect(result.health).toBe("UNKNOWN");
	});

	// Real-world regression observed on staging.fabric.pro after #1017:
	// the Gmail provider card surfaced the literal markdown heading
	// "**Summary**" as the incident description because the parser was
	// taking `most_recent_update.text.split("\n")[0]`. Google's feed
	// formats each update as a markdown document opening with a
	// `**Summary**` heading on line 1 and the actual sentence on line 2.
	// The parser must strip the heading marker and return the first
	// meaningful content line.
	describe("markdown title extraction (regression — #1017)", () => {
		it("strips a leading **Summary** markdown heading and surfaces the next line", async () => {
			mockFetch({
				ok: true,
				json: async () => [
					{
						id: "gmail-md-1",
						service_name: "Gmail",
						begin: "2099-01-01T00:00:00+00:00",
						end: null,
						status_impact: "SERVICE_DISRUPTION",
						most_recent_update: {
							status: "AVAILABLE",
							text: "**Summary**\nSome users may be unable to send messages.\n**Description**\nWe are investigating elevated send-error rates affecting a subset of users.",
						},
					},
				],
			});
			const result = await pollStatusPage(GMAIL_INPUT);
			expect(result.health).toBe("PARTIAL_OUTAGE");
			expect(result.openIncident?.name).toBe(
				"Some users may be unable to send messages.",
			);
			// Most importantly: NEVER the bare heading word.
			expect(result.openIncident?.name).not.toBe("**Summary**");
			expect(result.openIncident?.name).not.toBe("Summary");
		});

		it("falls back to external_desc when most_recent_update.text is missing", async () => {
			mockFetch({
				ok: true,
				json: async () => [
					{
						id: "gmail-md-2",
						service_name: "Gmail",
						begin: "2099-01-01T00:00:00+00:00",
						end: null,
						status_impact: "SERVICE_OUTAGE",
						external_desc:
							"**Summary**\nGmail send failing in EU regions.",
					},
				],
			});
			const result = await pollStatusPage(GMAIL_INPUT);
			expect(result.openIncident?.name).toBe(
				"Gmail send failing in EU regions.",
			);
		});

		it("matches the exact staging payload — Cameyo by Google example from the live feed", async () => {
			// Verbatim shape from
			// `https://www.google.com/appsstatus/dashboard/incidents.json`
			// on 2026-05-16. The user-facing description we want to surface
			// is the second line of `most_recent_update.text` ("Some Cameyo
			// by Google customers could not start their sessions ..."),
			// NOT the literal "**Summary**" heading.
			mockFetch({
				ok: true,
				json: async () => [
					{
						id: "ajqAKWeAiXrf8ezJ6CkK",
						number: "1320682224844797245",
						service_name: "Gmail",
						begin: "2026-05-12T16:01:00+00:00",
						end: null,
						status_impact: "SERVICE_INFORMATION",
						most_recent_update: {
							status: "AVAILABLE",
							text: "**Summary**\nSome Cameyo by Google customers could not start their sessions after rolling out the new channel version.\n**Description**\nWe were experiencing an issue with Cameyo by Google, beginning on Tuesday, 12 May 2026 09:01 US/Pacific.\n**Customer Symptoms**\nThe customers were experiencing an issue that couldn't connect to the Player VMs normally.\n**Workaround**\nNot needed because all affected servers have been mitigated.",
						},
					},
				],
			});
			const result = await pollStatusPage(GMAIL_INPUT);
			expect(result.openIncident?.name).toBe(
				"Some Cameyo by Google customers could not start their sessions after rolling out the new channel version.",
			);
		});

		it("strips a leading `# ATX heading` marker too", async () => {
			mockFetch({
				ok: true,
				json: async () => [
					{
						id: "gmail-md-3",
						service_name: "Gmail",
						begin: "2099-01-01T00:00:00+00:00",
						end: null,
						status_impact: "SERVICE_DISRUPTION",
						most_recent_update: {
							status: "AVAILABLE",
							text: "## Summary\nElevated 5xx errors on send.",
						},
					},
				],
			});
			const result = await pollStatusPage(GMAIL_INPUT);
			expect(result.openIncident?.name).toBe(
				"Elevated 5xx errors on send.",
			);
		});

		it("returns the cleaned heading itself when there is no following body (defensive fallback)", async () => {
			// Pathological response with only a heading — we never want to
			// silently throw or return `undefined`. Better to surface the
			// stripped heading text than nothing at all.
			mockFetch({
				ok: true,
				json: async () => [
					{
						id: "gmail-md-4",
						service_name: "Gmail",
						begin: "2099-01-01T00:00:00+00:00",
						end: null,
						status_impact: "SERVICE_DISRUPTION",
						most_recent_update: {
							status: "AVAILABLE",
							text: "**Summary**",
						},
					},
				],
			});
			const result = await pollStatusPage(GMAIL_INPUT);
			// Either the cleaned heading word "Summary" or the
			// `service_name` fallback is acceptable — both are far better
			// than the raw "**Summary**" literal users saw on staging.
			expect(result.openIncident?.name).not.toContain("**");
			expect(result.openIncident?.name).toBeTruthy();
		});

		// Real-world staging regression #2 (post-#1021): the live Gmail
		// description column on staging.fabric.pro still read literal
		// `**Summary**` because the DB row predated the parser fix AND
		// the upsert path only refreshed `summary` on a data-flip. The
		// parser was extended here to cover three additional shapes
		// observed in Google's incident feed beyond the canonical
		// `**Summary**\n<body>` template:
		//
		//   1. `**Title:**\n<body>` — heading word "Title" with a colon
		//   2. `**Title**\n<body>` — heading word "Title" without colon
		//   3. `# Incident Report\n## Summary\n<body>` — h1+h2 prefix
		//   4. `**Summary** <body>` — inline heading on the same line
		//
		// These are not hypothetical: pulling
		// https://www.google.com/appsstatus/dashboard/incidents.json
		// on 2026-05-17 returned all four shapes across the 7 visible
		// Gmail incidents (active + ended). The parser must surface the
		// human-readable body, never the heading word.
		describe("expanded heading vocabulary (#1021 follow-up)", () => {
			it("handles **Title:** with a trailing colon as a section heading", async () => {
				mockFetch({
					ok: true,
					json: async () => [
						{
							id: "gmail-title-colon",
							service_name: "Gmail",
							begin: "2099-01-01T00:00:00+00:00",
							end: null,
							status_impact: "SERVICE_DISRUPTION",
							most_recent_update: {
								status: "AVAILABLE",
								text: "**Title:**\nCustomers may experience delays in receiving and sending emails.\n**Description:**\nWe are investigating.",
							},
						},
					],
				});
				const result = await pollStatusPage(GMAIL_INPUT);
				expect(result.openIncident?.name).toBe(
					"Customers may experience delays in receiving and sending emails.",
				);
				expect(result.openIncident?.name).not.toContain("Title");
			});

			it("handles **Title** without a colon as a section heading", async () => {
				mockFetch({
					ok: true,
					json: async () => [
						{
							id: "gmail-title-plain",
							service_name: "Gmail",
							begin: "2099-01-01T00:00:00+00:00",
							end: null,
							status_impact: "SERVICE_INFORMATION",
							most_recent_update: {
								status: "AVAILABLE",
								text: "**Title**\nGmail is experiencing an issue with images not loading properly.\n**Description**\nWe are investigating.",
							},
						},
					],
				});
				const result = await pollStatusPage(GMAIL_INPUT);
				expect(result.openIncident?.name).toBe(
					"Gmail is experiencing an issue with images not loading properly.",
				);
				expect(result.openIncident?.name).not.toBe("Title");
			});

			it("handles `# Incident Report\\n## Summary\\n<body>` h1+h2 prefix", async () => {
				// Observed shape on the 2026-04-08 Gmail post-mortem feed:
				// `# Incident Report\n## Summary\nOn Wednesday...`. Without
				// the "incident report" heading word, the parser would
				// surface "Incident Report" as the description.
				mockFetch({
					ok: true,
					json: async () => [
						{
							id: "gmail-pm",
							service_name: "Gmail",
							begin: "2099-01-01T00:00:00+00:00",
							end: null,
							status_impact: "SERVICE_DISRUPTION",
							most_recent_update: {
								status: "AVAILABLE",
								text: "# Incident Report\n## Summary\nOn Wednesday, 08 April 2026, Gmail customers may have experienced delays.",
							},
						},
					],
				});
				const result = await pollStatusPage(GMAIL_INPUT);
				expect(result.openIncident?.name).toBe(
					"On Wednesday, 08 April 2026, Gmail customers may have experienced delays.",
				);
				expect(result.openIncident?.name).not.toContain(
					"Incident Report",
				);
			});

			it("handles inline `**Summary** <body>` on a single line", async () => {
				// Some shorter updates squash the heading and body onto the
				// same line. The parser must strip the leading heading word
				// without dropping the body. Observed shape on Google Cloud
				// `monitoring` quick updates.
				mockFetch({
					ok: true,
					json: async () => [
						{
							id: "gmail-inline",
							service_name: "Gmail",
							begin: "2099-01-01T00:00:00+00:00",
							end: null,
							status_impact: "SERVICE_INFORMATION",
							most_recent_update: {
								status: "AVAILABLE",
								text: "**Summary** Elevated send error rates affecting a subset of users.",
							},
						},
					],
				});
				const result = await pollStatusPage(GMAIL_INPUT);
				expect(result.openIncident?.name).toBe(
					"Elevated send error rates affecting a subset of users.",
				);
				// Critically: never surface the bare "Summary" prefix.
				expect(result.openIncident?.name).not.toMatch(/^Summary\b/i);
			});

			it("handles inline `**Summary:** <body>` on a single line with a colon separator", async () => {
				mockFetch({
					ok: true,
					json: async () => [
						{
							id: "gmail-inline-colon",
							service_name: "Gmail",
							begin: "2099-01-01T00:00:00+00:00",
							end: null,
							status_impact: "SERVICE_INFORMATION",
							most_recent_update: {
								status: "AVAILABLE",
								text: "**Summary:** Elevated 5xx error rates on send.",
							},
						},
					],
				});
				const result = await pollStatusPage(GMAIL_INPUT);
				expect(result.openIncident?.name).toBe(
					"Elevated 5xx error rates on send.",
				);
				expect(result.openIncident?.name).not.toMatch(/^Summary[:]/);
			});

			it("matches the live 2026-05-17 active Gmail incident verbatim", async () => {
				// Verbatim payload pulled from
				// https://www.google.com/appsstatus/dashboard/incidents.json
				// at 2026-05-17. The user-visible description we want to
				// surface is the second line of `most_recent_update.text`
				// — "Gmail Android users using Microsoft Exchange Online
				// may fail to log in due to authentication issues." —
				// NOT the literal `**Summary**` heading.
				mockFetch({
					ok: true,
					json: async () => [
						{
							id: "kWSuRqLdsXGzT7Qxjdmz",
							number: "1320682224844797246",
							service_name: "Gmail",
							begin: "2026-05-06T16:00:00+00:00",
							end: null,
							status_impact: "SERVICE_INFORMATION",
							most_recent_update: {
								status: "AVAILABLE",
								text: "**Summary**\nGmail Android users using Microsoft Exchange Online may fail to log in due to authentication issues.\n**Description**\nWe are experiencing an issue with Gmail beginning on Saturday 2026-05-06.\nOur engineering team continues to investigate the issue.\n**Customer Symptoms**\nImpacted users may experience authentication failures while logging in to Microsoft Exchange Online through\nGmail App on Android devices.\n**Workaround**\nAffected users can use Microsoft web app to access the Inbox.",
							},
						},
					],
				});
				const result = await pollStatusPage(GMAIL_INPUT);
				expect(result.openIncident?.name).toBe(
					"Gmail Android users using Microsoft Exchange Online may fail to log in due to authentication issues.",
				);
				expect(result.openIncident?.name).not.toContain("**");
				expect(result.openIncident?.name).not.toBe("Summary");
			});
		});
	});
});

describe("pollStatusPage — google-cloud custom parser", () => {
	const BIGQUERY_INPUT = {
		providerKey: "bigquery",
		url: "https://status.cloud.google.com/incidents.json",
		customParser: "google-cloud" as const,
		googleCloudProductTitle: "BigQuery",
	};

	it("returns OPERATIONAL with shouldCloseExisting when no live BigQuery incident", async () => {
		mockFetch({ ok: true, json: async () => [] });
		const result = await pollStatusPage(BIGQUERY_INPUT);
		expect(result.health).toBe("OPERATIONAL");
		expect(result.shouldCloseExisting).toBe(true);
	});

	it("ranks a coexisting SERVICE_OUTAGE above SERVICE_INFORMATION", async () => {
		mockFetch({
			ok: true,
			json: async () => [
				{
					id: "info-1",
					service_name: "Multiple Products",
					begin: "2099-01-01T00:00:00+00:00",
					end: null,
					status_impact: "SERVICE_INFORMATION",
					affected_products: [{ title: "BigQuery" }],
				},
				{
					id: "outage-1",
					service_name: "BigQuery",
					begin: "2099-01-01T00:00:00+00:00",
					end: null,
					status_impact: "SERVICE_OUTAGE",
					affected_products: [{ title: "BigQuery" }],
					external_desc: "BigQuery queries failing region-wide",
				},
			],
		});
		const result = await pollStatusPage(BIGQUERY_INPUT);
		expect(result.health).toBe("MAJOR_OUTAGE");
		expect(result.openIncident?.id).toBe("outage-1");
	});

	it("filters by affected_products[].title (not service_name)", async () => {
		mockFetch({
			ok: true,
			json: async () => [
				{
					id: "compute-1",
					service_name: "Compute Engine",
					begin: "2099-01-01T00:00:00+00:00",
					end: null,
					status_impact: "SERVICE_OUTAGE",
					affected_products: [{ title: "Compute Engine" }],
				},
				{
					id: "bq-1",
					service_name: "Multiple Products",
					begin: "2099-01-01T00:00:00+00:00",
					end: null,
					status_impact: "SERVICE_DISRUPTION",
					affected_products: [
						{ title: "Compute Engine" },
						{ title: "BigQuery" },
					],
				},
			],
		});
		const result = await pollStatusPage(BIGQUERY_INPUT);
		expect(result.health).toBe("PARTIAL_OUTAGE");
		expect(result.openIncident?.id).toBe("bq-1");
	});

	it("treats ended incidents (end < now) as resolved", async () => {
		mockFetch({
			ok: true,
			json: async () => [
				{
					id: "ended-1",
					service_name: "BigQuery",
					begin: "2025-01-01T00:00:00+00:00",
					end: "2025-01-02T00:00:00+00:00",
					status_impact: "SERVICE_OUTAGE",
					affected_products: [{ title: "BigQuery" }],
				},
			],
		});
		const result = await pollStatusPage(BIGQUERY_INPUT);
		expect(result.health).toBe("OPERATIONAL");
	});
});

describe("pollStatusPage — slack custom parser", () => {
	const SLACK_INPUT = {
		providerKey: "slack",
		url: "https://status.slack.com/api/v2.0.0/current",
		customParser: "slack" as const,
	};

	it("maps `status: 'ok'` + empty incidents to OPERATIONAL", async () => {
		mockFetch({
			ok: true,
			json: async () => ({
				status: "ok",
				date_updated: "2026-05-14T08:34:48-07:00",
				active_incidents: [],
			}),
		});
		const result = await pollStatusPage(SLACK_INPUT);
		expect(result.health).toBe("OPERATIONAL");
		expect(result.shouldCloseExisting).toBe(true);
	});

	it("maps an active 'outage' to PARTIAL_OUTAGE with the listed services as components", async () => {
		mockFetch({
			ok: true,
			json: async () => ({
				status: "active",
				active_incidents: [
					{
						id: 1234,
						title: "Messaging issues",
						status: "active",
						type: "outage",
						services: ["Messaging", "Files"],
					},
				],
			}),
		});
		const result = await pollStatusPage(SLACK_INPUT);
		expect(result.health).toBe("PARTIAL_OUTAGE");
		expect(result.openIncident?.name).toBe("Messaging issues");
		expect(result.openIncident?.affectedComponents).toEqual([
			"Messaging",
			"Files",
		]);
	});

	it("maps an active 'incident' to DEGRADED", async () => {
		mockFetch({
			ok: true,
			json: async () => ({
				status: "active",
				active_incidents: [
					{
						id: 1,
						title: "Search latency",
						status: "active",
						type: "incident",
					},
				],
			}),
		});
		const result = await pollStatusPage(SLACK_INPUT);
		expect(result.health).toBe("DEGRADED");
	});

	it("skips resolved incidents in the active_incidents array", async () => {
		mockFetch({
			ok: true,
			json: async () => ({
				status: "ok",
				active_incidents: [
					{
						id: 1,
						title: "fixed",
						status: "resolved",
						type: "outage",
					},
				],
			}),
		});
		const result = await pollStatusPage(SLACK_INPUT);
		expect(result.health).toBe("OPERATIONAL");
	});

	it("returns UNKNOWN when the top-level status field is missing", async () => {
		mockFetch({ ok: true, json: async () => ({ active_incidents: [] }) });
		const result = await pollStatusPage(SLACK_INPUT);
		expect(result.health).toBe("UNKNOWN");
	});
});

describe("pollStatusPage — status-io custom parser", () => {
	const GITLAB_INPUT = {
		providerKey: "gitlab",
		url: "https://api.status.io/1.0/status/5b36dc6502d06804c08349f7",
		customParser: "status-io" as const,
	};

	it("maps status_code 100 to OPERATIONAL", async () => {
		mockFetch({
			ok: true,
			json: async () => ({
				result: {
					status_overall: {
						status: "Operational",
						status_code: 100,
					},
					status: [],
					incidents: [],
					maintenance: { active: [] },
				},
			}),
		});
		const result = await pollStatusPage(GITLAB_INPUT);
		expect(result.health).toBe("OPERATIONAL");
		expect(result.shouldCloseExisting).toBe(true);
	});

	it("maps status_code 300 to DEGRADED with the listed incident", async () => {
		mockFetch({
			ok: true,
			json: async () => ({
				result: {
					status_overall: {
						status: "Degraded Performance",
						status_code: 300,
					},
					incidents: [
						{
							_id: "incident-x",
							name: "CI/CD pipelines slow",
							components_affected: [{ name: "CI/CD" }],
						},
					],
					maintenance: { active: [] },
				},
			}),
		});
		const result = await pollStatusPage(GITLAB_INPUT);
		expect(result.health).toBe("DEGRADED");
		expect(result.openIncident?.id).toBe("incident-x");
		expect(result.openIncident?.affectedComponents).toEqual(["CI/CD"]);
	});

	it("maps status_code 400 to PARTIAL_OUTAGE", async () => {
		mockFetch({
			ok: true,
			json: async () => ({
				result: {
					status_overall: {
						status: "Partial Service Disruption",
						status_code: 400,
					},
					incidents: [{ _id: "x", name: "y" }],
					maintenance: { active: [] },
				},
			}),
		});
		const result = await pollStatusPage(GITLAB_INPUT);
		expect(result.health).toBe("PARTIAL_OUTAGE");
	});

	it("maps status_code 500 to MAJOR_OUTAGE + SEV1", async () => {
		mockFetch({
			ok: true,
			json: async () => ({
				result: {
					status_overall: {
						status: "Service Disruption",
						status_code: 500,
					},
					incidents: [
						{ _id: "down", name: "GitLab.com unavailable" },
					],
					maintenance: { active: [] },
				},
			}),
		});
		const result = await pollStatusPage(GITLAB_INPUT);
		expect(result.health).toBe("MAJOR_OUTAGE");
		expect(result.severity).toBe("SEV1");
	});

	it("returns MAINTENANCE when an active maintenance window coexists with operational", async () => {
		mockFetch({
			ok: true,
			json: async () => ({
				result: {
					status_overall: { status: "Operational", status_code: 100 },
					incidents: [],
					maintenance: {
						active: [
							{
								_id: "maint-1",
								name: "Scheduled DB rotation",
							},
						],
					},
				},
			}),
		});
		const result = await pollStatusPage(GITLAB_INPUT);
		expect(result.health).toBe("MAINTENANCE");
		expect(result.openIncident?.name).toBe("Scheduled DB rotation");
	});

	it("returns UNKNOWN when result.status_overall.status_code is missing", async () => {
		mockFetch({ ok: true, json: async () => ({ result: {} }) });
		const result = await pollStatusPage(GITLAB_INPUT);
		expect(result.health).toBe("UNKNOWN");
	});
});

describe("pollStatusPage — salesforce custom parser", () => {
	const SALESFORCE_INPUT = {
		providerKey: "salesforce",
		url: "https://api.status.salesforce.com/v1/incidents/active",
		customParser: "salesforce" as const,
	};

	it("maps empty array to OPERATIONAL + shouldCloseExisting=true", async () => {
		mockFetch({ ok: true, json: async () => [] });
		const result = await pollStatusPage(SALESFORCE_INPUT);
		expect(result.health).toBe("OPERATIONAL");
		expect(result.shouldCloseExisting).toBe(true);
		expect(result.openIncident).toBeNull();
	});

	it("maps a minor severity active incident to DEGRADED", async () => {
		mockFetch({
			ok: true,
			json: async () => [
				{
					id: 12345,
					externalId: "ABC-123",
					status: "Confirmed",
					type: "Degradation",
					affectsAll: false,
					IncidentImpacts: [{ severity: "minor", type: "feature" }],
					serviceKeys: ["coreService"],
				},
			],
		});
		const result = await pollStatusPage(SALESFORCE_INPUT);
		expect(result.health).toBe("DEGRADED");
		expect(result.openIncident?.id).toBe("ABC-123");
	});

	it("maps a major severity active incident to PARTIAL_OUTAGE", async () => {
		mockFetch({
			ok: true,
			json: async () => [
				{
					id: 22222,
					externalId: "MAJ-1",
					status: "Confirmed",
					type: "Disruption",
					affectsAll: false,
					IncidentImpacts: [{ severity: "major" }],
				},
			],
		});
		const result = await pollStatusPage(SALESFORCE_INPUT);
		expect(result.health).toBe("PARTIAL_OUTAGE");
	});

	it("escalates `affectsAll: true` Disruption to MAJOR_OUTAGE + SEV1", async () => {
		mockFetch({
			ok: true,
			json: async () => [
				{
					id: 33333,
					externalId: "ALL-1",
					status: "Confirmed",
					type: "Disruption",
					affectsAll: true,
					IncidentImpacts: [{ severity: "major" }],
				},
			],
		});
		const result = await pollStatusPage(SALESFORCE_INPUT);
		expect(result.health).toBe("MAJOR_OUTAGE");
		expect(result.severity).toBe("SEV1");
	});

	it("skips incidents marked Resolved when /active leaked stale rows", async () => {
		mockFetch({
			ok: true,
			json: async () => [
				{
					id: 1,
					externalId: "OLD",
					status: "Resolved",
					type: "Degradation",
					IncidentImpacts: [{ severity: "major" }],
				},
			],
		});
		const result = await pollStatusPage(SALESFORCE_INPUT);
		expect(result.health).toBe("OPERATIONAL");
	});

	it("returns UNKNOWN when the response is not an array", async () => {
		mockFetch({
			ok: true,
			json: async () => ({ message: "Instance Not Found" }),
		});
		const result = await pollStatusPage(SALESFORCE_INPUT);
		expect(result.health).toBe("UNKNOWN");
	});
});

describe("pollStatusPage — zendesk-ssp custom parser", () => {
	const ZENDESK_INPUT = {
		providerKey: "zendesk",
		url: "https://status.zendesk.com/api/ssp/incidents.json",
		customParser: "zendesk-ssp" as const,
	};

	it("returns OPERATIONAL with shouldCloseExisting when only resolved incidents are listed", async () => {
		mockFetch({
			ok: true,
			json: async () => ({
				data: [
					{
						id: "1",
						type: "incident",
						attributes: {
							name: "old",
							impact: "major",
							status: "resolved",
							resolvedAt: "2026-05-13T18:38:00.000Z",
						},
					},
				],
			}),
		});
		const result = await pollStatusPage(ZENDESK_INPUT);
		expect(result.health).toBe("OPERATIONAL");
		expect(result.shouldCloseExisting).toBe(true);
	});

	it("maps impact=critical on an active incident to MAJOR_OUTAGE + SEV1", async () => {
		mockFetch({
			ok: true,
			json: async () => ({
				data: [
					{
						id: "9999",
						type: "incident",
						attributes: {
							name: "Pod 13 outage",
							impact: "critical",
							status: "investigating",
							outage: true,
							resolvedAt: null,
						},
					},
				],
			}),
		});
		const result = await pollStatusPage(ZENDESK_INPUT);
		expect(result.health).toBe("MAJOR_OUTAGE");
		expect(result.severity).toBe("SEV1");
		expect(result.openIncident?.id).toBe("9999");
	});

	it("maps impact=major to PARTIAL_OUTAGE", async () => {
		mockFetch({
			ok: true,
			json: async () => ({
				data: [
					{
						id: "100",
						type: "incident",
						attributes: {
							name: "Talk degraded",
							impact: "major",
							status: "monitoring",
							resolvedAt: null,
						},
					},
				],
			}),
		});
		const result = await pollStatusPage(ZENDESK_INPUT);
		expect(result.health).toBe("PARTIAL_OUTAGE");
	});

	it("maps impact=minor to DEGRADED", async () => {
		mockFetch({
			ok: true,
			json: async () => ({
				data: [
					{
						id: "200",
						type: "incident",
						attributes: {
							name: "Analytics slow",
							impact: "minor",
							status: "investigating",
							resolvedAt: null,
						},
					},
				],
			}),
		});
		const result = await pollStatusPage(ZENDESK_INPUT);
		expect(result.health).toBe("DEGRADED");
	});

	it("returns UNKNOWN when the response is missing the data array", async () => {
		mockFetch({ ok: true, json: async () => ({ included: [] }) });
		const result = await pollStatusPage(ZENDESK_INPUT);
		expect(result.health).toBe("UNKNOWN");
	});
});
