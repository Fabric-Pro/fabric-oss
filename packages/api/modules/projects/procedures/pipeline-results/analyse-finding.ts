import { getFindingForAnalysis, setFindingAnalysis } from "@repo/database";
import { logger } from "@repo/logs";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { analyseTestFailure } from "../../lib/analyse-test-failure";
import { assertPipelineResultsEnabled } from "../../lib/pipeline-results-feature";
import { resolveFailureDiff } from "../../lib/resolve-failure-diff";

/**
 * Propose a cause for one QA finding — the model half of the CI/CD setup work:
 * the pipeline reports a failure, this suggests why.
 *
 * Write-gated by TEST_CASE_UPDATE because it spends tokens and writes to the
 * finding, and button-triggered rather than automatic: analysing every failure a
 * sync ingests would bill a customer for reasoning nobody asked to read.
 *
 * **It never files anything.** The result is four advisory columns on the
 * finding; `status` is untouched, no bug is opened, and `suspectedKind` is not a
 * trigger. Promotion stays a person's action — the product ruling on 2026-07-26,
 * not an implementation detail waiting to be optimised away.
 *
 * Not audited, deliberately and for consistency: the directly comparable model
 * call (`generateQaAnalysis`, same shape — user-triggered, spends tokens, writes
 * a derived field to a tenant row) is not audited either. Auditing one and not
 * its twin would be worse than auditing neither. If AI actions should be in the
 * ledger that is one uniform change across them, not a special case here.
 */
export const analyseQaFindingProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/qa/findings/{findingId}/analyse",
		tags: ["Projects", "Test Cases"],
		summary: "Propose a likely cause for a tracked CI failure",
	})
	.input(z.object({ projectId: z.string(), findingId: z.string() }))
	.handler(async ({ input, context }) => {
		assertPipelineResultsEnabled();
		const user = context.user;

		const finding = await getFindingForAnalysis({
			projectId: input.projectId,
			findingId: input.findingId,
		});
		if (!finding) {
			// Returned, not thrown: a finding deleted between render and click is
			// an ordinary race, and a 404 in the console is a worse answer than a
			// sentence on screen.
			//
			// Note what this does NOT cover. The lookup filters on id, projectId
			// and deletedAt — never on status — so a finding a later sync moved to
			// RESOLVED is still analysed, successfully. That is deliberate (why a
			// test WAS failing is worth knowing after it goes green), and it is
			// why the copy for this reason says "no longer exists" rather than
			// blaming a resolving run, which cannot produce it.
			return { analysed: false as const, reason: "NOT_FOUND" as const };
		}

		// What changed since this test last passed. Best-effort by
		// construction: the analysis was useful before the diff existed and must
		// stay useful when it cannot be fetched, so a disconnected repo or an
		// unresolvable commit range degrades to the shipped behaviour rather than
		// failing the analysis. The evidence block states the absence explicitly,
		// so a cause proposed without the diff never reads as diff correlation.
		const diff = await resolveFailureDiff({
			projectId: input.projectId,
			findingId: input.findingId,
			userId: user.id,
			organizationId: finding.organizationId,
			testName: finding.testName,
			classname: finding.classname,
			specFilePath: finding.specFilePath,
		});

		let analysis: Awaited<ReturnType<typeof analyseTestFailure>>;
		try {
			analysis = await analyseTestFailure({
				failure: {
					...finding,
					commitRange: diff?.commitRange ?? null,
					changedFiles: diff?.changedFiles,
					changedFilesTruncated: diff?.truncated,
				},
				// The finding's own XOR owner, not a client-supplied id: the
				// org whose prompt override applies is a server-side fact.
				tenant: {
					userId: user.id,
					organizationId: finding.organizationId ?? undefined,
				},
			});
		} catch (err) {
			// A model that is down, rate-limited or out of credit is not a Fabric
			// fault and not something the reader can fix by retrying harder. Log
			// it with enough to diagnose — never the failure text itself, which is
			// customer code — and hand back a refusal.
			logger.error("qa.finding.analysis_failed", {
				projectId: input.projectId,
				findingId: input.findingId,
				userId: user.id,
				error: err instanceof Error ? err.message : String(err),
			});
			return { analysed: false as const, reason: "MODEL_ERROR" as const };
		}

		if (!analysis) {
			// The prompt is not seeded in this environment. Surfaced rather than
			// silently substituting an inlined copy: an analysis produced by a
			// prompt no admin can see or edit is exactly what the editable-prompt
			// rule exists to prevent.
			return {
				analysed: false as const,
				reason: "PROMPT_UNAVAILABLE" as const,
			};
		}

		if (!analysis.suspectedCause) {
			// The model answered with nothing usable. Not stored: an empty cause
			// beside an UNKNOWN badge would read as "we analysed this and learned
			// nothing", which is indistinguishable from a bug in this feature.
			return {
				analysed: false as const,
				reason: "NO_CONCLUSION" as const,
			};
		}

		const { updated } = await setFindingAnalysis({
			projectId: input.projectId,
			findingId: input.findingId,
			suspectedCause: analysis.suspectedCause,
			suspectedKind: analysis.kind,
			analysisModel: analysis.model,
			// Stored beside the cause so the reader sees the same evidence the
			// model did. Explicitly null when there was no diff, which CLEARS any
			// list a previous analysis left behind — otherwise the old suspects
			// would sit under the new hypothesis and read as its reasoning.
			analysisDiff: diff,
		});
		if (!updated) {
			// Same race as above, caught on the write side.
			return { analysed: false as const, reason: "NOT_FOUND" as const };
		}

		return {
			analysed: true as const,
			suspectedCause: analysis.suspectedCause,
			suspectedKind: analysis.kind,
			analysisModel: analysis.model,
			analysisDiff: diff,
		};
	});
