/**
 * The two lenses, without a request around them.
 *
 * Both were handlers, and both are now functions the handlers call — because the
 * automatic review driven by GitHub's webhook has to run exactly the same checks
 * as the button, and a second implementation of "what the QA lens does" would
 * drift within a release.
 *
 * What stayed with the procedures is what only a request has: the permission
 * check, and the audit record naming the person. What moved here is the work.
 */

import { ORPCError } from "@orpc/client";
import {
	diffFilePaths,
	PR_REVIEW_MAX_FEATURES,
	reviewPullRequestForQa,
} from "@repo/ai";
import {
	getProjectImportGraph,
	getProjectQaSettings,
	getPullRequestReview,
	listFeaturesForPrReview,
	type PullRequestReviewFindingRow,
	replaceLensFindings,
} from "@repo/database";
import {
	findArchitectureViolations,
	parseArchitectureRules,
} from "@repo/utils/architecture-rules";
import { findImportCycles } from "@repo/utils/import-cycles";

const QA_LENS = "QA";
const ARCHITECTURE_LENS = "ARCHITECTURE";

/** Cycles reported from one run — see the procedure's own note on burying. */
const MAX_CYCLES = 10;
/** Declared-rule breaches reported from one run, bounded for the same reason. */
const MAX_VIOLATIONS = 10;
/** Cycle members named in a title before it summarises. */
const TITLE_MEMBERS = 3;

export interface QaLensResult {
	configured: boolean;
	findings: PullRequestReviewFindingRow[];
	dropped: number;
	model: string | null;
}

export async function runQaLens(input: {
	projectId: string;
	reviewId: string;
	userId: string;
	organizationId: string | null;
}): Promise<QaLensResult> {
	const settings = await getProjectQaSettings(input.projectId);
	if (!settings.prReviewQaLensEnabled) {
		throw new ORPCError("BAD_REQUEST", {
			message:
				"The QA review lens is turned off for this project. Turn it on in Settings ▸ Testing to run it.",
		});
	}

	const review = await getPullRequestReview({
		id: input.reviewId,
		projectId: input.projectId,
	});
	if (!review) {
		throw new ORPCError("NOT_FOUND", {
			message: "That pull-request review was not found.",
		});
	}
	// A review whose diff never arrived has nothing to reason over. Refusing
	// beats spending credits to have a model speculate from a title.
	if (!review.diff) {
		throw new ORPCError("BAD_REQUEST", {
			message:
				review.failureText ??
				"Fabric stored no diff for this pull request, so there is nothing to review.",
		});
	}

	const features = await listFeaturesForPrReview({
		projectId: input.projectId,
		limit: PR_REVIEW_MAX_FEATURES,
	});

	const result = await reviewPullRequestForQa({
		diff: review.diff,
		diffTruncated: review.diffTruncated,
		features,
		// The pull-request review work scope: light projects get a lighter QA review. The same
		// setting the test-case drafter reads, so one depth means one thing.
		strategyDepth: settings.strategyDepth,
		context: {
			userId: input.userId,
			// The project's own tenant, resolved server-side by the query layer.
			// Deliberately not taken from the caller — see the ratchet in
			// `input-org-unverified-ratchet.test.ts`.
			organizationId: input.organizationId,
			projectId: input.projectId,
		},
	});
	// Null is the "no AI provider configured" state, not a failure. Returned as
	// data so the panel renders a soft hint instead of a red error.
	if (result === null) {
		return { configured: false, findings: [], dropped: 0, model: null };
	}

	const findings = await replaceLensFindings({
		reviewId: review.id,
		projectId: input.projectId,
		lens: QA_LENS,
		model: result.model,
		analysedAt: new Date(),
		findings: result.findings,
	});

	return {
		configured: true,
		findings,
		dropped: result.dropped,
		model: result.model,
	};
}

export interface ArchitectureLensResult {
	indexed: boolean;
	/** The Atlas analysis the graph came from. Null when nothing is indexed. */
	analysisId: string | null;
	/** How many rules the project declared — an audit needs the denominator. */
	rulesDeclared: number;
	findings: PullRequestReviewFindingRow[];
	cyclesInRepo: number;
	cyclesTouched: number;
	violationsInRepo: number;
	violationsTouched: number;
}

export async function runArchitectureLens(input: {
	projectId: string;
	reviewId: string;
}): Promise<ArchitectureLensResult> {
	const settings = await getProjectQaSettings(input.projectId);
	if (!settings.prReviewArchitectureLensEnabled) {
		throw new ORPCError("BAD_REQUEST", {
			message:
				"The architecture review lens is turned off for this project. Turn it on in Settings ▸ Testing to run it.",
		});
	}

	const review = await getPullRequestReview({
		id: input.reviewId,
		projectId: input.projectId,
	});
	if (!review) {
		throw new ORPCError("NOT_FOUND", {
			message: "That pull-request review was not found.",
		});
	}
	if (!review.diff) {
		throw new ORPCError("BAD_REQUEST", {
			message:
				review.failureText ??
				"Fabric stored no diff for this pull request, so there is nothing to review.",
		});
	}

	const graph = await getProjectImportGraph({
		projectId: input.projectId,
	});
	// No indexed repository means no graph. Returned as data, not thrown, and
	// deliberately NOT written as "analysed with no findings": "we have never
	// mapped your imports" and "your imports are fine" are different facts, and
	// conflating them is the reassurance-nobody-earned failure again.
	if (graph.analysisId === null) {
		return {
			indexed: false,
			analysisId: null,
			rulesDeclared: 0,
			findings: [],
			cyclesInRepo: 0,
			cyclesTouched: 0,
			violationsInRepo: 0,
			violationsTouched: 0,
		};
	}

	const changed = diffFilePaths(review.diff);
	const cycles = findImportCycles(graph.edges);
	// Only cycles this pull request is IN. A cycle that exists but that this
	// change did not touch is the repository's problem, not this PR's, and
	// attaching it here is how a review list becomes something people skim past.
	const touched = cycles.filter((cycle) =>
		cycle.members.some((member) => changed.has(member)),
	);

	// Two rules, and both are properties of the reviewed project rather than
	// of this one.
	//
	// Layer rules ("a package may only import what it declares"; "a library
	// may not import an application") were checked here until it turned out
	// they cannot be, for a repository that is not this one: the declarations
	// were read from THIS server's filesystem while the edges came from the
	// reviewed project's index, and the directory convention the direction
	// rule encodes is a convention of this repository that a customer never
	// agreed to. Both produced findings whose only real content was the
	// checker's own assumptions.
	//
	// A cycle survives that objection because it is a property of the
	// reviewed project's own graph. Design-pattern compliance survives it a
	// different way: the project DECLARES what its architecture forbids and
	// what it requires, and this checks the graph against what they wrote.
	// A required rule is what makes "pattern compliance" checkable at all
	// without inference — "every route file imports the auth guard" is a
	// pattern a team can state and a graph can settle. Nothing is inferred
	// from folder names, and a project that declares nothing gets no
	// findings, which is the honest answer rather than a guess dressed as
	// one.

	const cycleFindings = touched.slice(0, MAX_CYCLES).map((cycle) => {
		const inThisChange = cycle.members.filter((m) => changed.has(m));
		const named = cycle.members.slice(0, TITLE_MEMBERS).join(" ↔ ");
		const rest =
			cycle.members.length > TITLE_MEMBERS
				? ` and ${cycle.members.length - TITLE_MEMBERS} more`
				: "";
		return {
			// A two-file cycle is a local tangle; a large one is a module boundary
			// that has stopped existing. Severity from size, computed like
			// everything else here.
			severity: cycle.members.length > 2 ? "HIGH" : "MEDIUM",
			title: `Circular import: ${named}${rest}`,
			detail: [
				`${cycle.members.length} files import each other in a cycle. One way round it: ${cycle.path.join(" → ")}.`,
				`This change touches ${inThisChange.length} of them: ${inThisChange.join(", ")}.`,
				`Full member list: ${cycle.members.join(", ")}.`,
			].join("\n\n"),
			// Composed from the cycle this code already proved, naming an edge
			// that exists rather than advice in general. The edge picked is the
			// one leaving a file this change touched, so the reader starts where
			// they are already working.
			recommendation: `Break one edge in the cycle: move what ${inThisChange[0] ?? cycle.path[0]} needs from ${cycle.path[1] ?? cycle.path[0]} into a module both can import, or invert the dependency. Removing any single edge in ${cycle.path.join(" → ")} is enough.`,
			// The member this change actually touched, so the finding points at
			// something in the diff rather than at an arbitrary cycle member.
			filePath: inThisChange[0] ?? null,
			// No line: a cycle is a property of a whole file's imports, not of one
			// line in it, and inventing one would be precision this does not have.
			line: null,
			storyId: null,
			criterionRef: null,
		};
	});

	// Rules the project recorded. Parse errors are ignored here on purpose:
	// the settings page names the bad line at the point somebody can fix it,
	// and refusing to run the whole lens because line 7 is malformed would
	// lose the cycle findings too.
	const { rules } = parseArchitectureRules(settings.architectureRules);
	const violations = findArchitectureViolations({
		edges: graph.edges,
		rules,
	});
	// Only violations this pull request introduced, matching the cycle rule
	// above: a rule this repository has been breaking for a year is the
	// repository's problem, and attaching it here buries what the change did.
	const violationsTouched = violations.filter((v) => changed.has(v.fromPath));

	const violationFindings = violationsTouched
		.slice(0, MAX_VIOLATIONS)
		.map((v) =>
			v.rule.kind === "required"
				? {
						// Same severity as a forbidden import, and for the same
						// reason: both are conventions the team wrote down, and
						// neither outranks a cycle.
						severity: "MEDIUM",
						title: `Missing required import: ${v.fromPath}`,
						detail: [
							`${v.fromPath} imports nothing matching \`${v.rule.to}\`, which this project's architecture rules require of files matching \`${v.rule.from}\`.`,
							`The rule: \`${v.rule.from} => ${v.rule.to}\` — ${v.rule.reason}`,
						].join("\n\n"),
						recommendation: `Import what \`${v.rule.to}\` names in ${v.fromPath}, or narrow the rule if this file is a deliberate exception. Edit the rules under Settings ▸ Testing ▸ Pull-request review lenses.`,
						filePath: v.fromPath,
						// No line: the finding is about an import the file does
						// not have, so there is nowhere in it to point.
						line: null,
						storyId: null,
						criterionRef: null,
					}
				: {
						// MEDIUM, not HIGH: this is a convention the team chose, not a
						// defect, and a rule somebody wrote last week should not outrank a
						// circular import in the same list.
						severity: "MEDIUM",
						title: `Forbidden import: ${v.fromPath} → ${v.toPath}`,
						detail: [
							`${v.fromPath} imports ${v.toPath}, which this project's architecture rules forbid.`,
							`The rule: \`${v.rule.from} -> ${v.rule.to}\` — ${v.rule.reason}`,
						].join("\n\n"),
						// Two ways out, and the second is not a cop-out: a rule the team no
						// longer means is worth deleting, and saying so keeps the lens from
						// reading as though the rule outranks the people who wrote it.
						recommendation: `Drop the import from ${v.fromPath} to ${v.toPath}, reaching what it needs through a module the rule allows. If the rule no longer reflects how this project is built, edit it under Settings ▸ Testing ▸ Pull-request review lenses.`,
						filePath: v.fromPath,
						// No line. The graph records that one file imports
						// another, not which line did it, and inventing one would
						// be precision this does not have.
						line: null,
						storyId: null,
						criterionRef: null,
					},
		);

	const findings = [...cycleFindings, ...violationFindings];

	const stored = await replaceLensFindings({
		reviewId: review.id,
		projectId: input.projectId,
		lens: ARCHITECTURE_LENS,
		// No model produced these, so none is recorded. A model name here would
		// be a lie about provenance.
		model: null,
		analysedAt: new Date(),
		findings,
	});

	return {
		indexed: true,
		analysisId: graph.analysisId,
		rulesDeclared: rules.length,
		findings: stored,
		cyclesInRepo: cycles.length,
		cyclesTouched: touched.length,
		violationsInRepo: violations.length,
		violationsTouched: violationsTouched.length,
	};
}
