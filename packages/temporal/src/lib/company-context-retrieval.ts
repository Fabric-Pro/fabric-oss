/**
 * Company context retrieval for Proposal and Business Case generation
 * (Fizzy #2719).
 *
 * An organization keeps sources about itself — case studies, service
 * descriptions, its website — once, and generation draws on them alongside the
 * project's own context. This module produces the company half of
 * `retrieveProjectContexts`: a short list of context strings, each labeled as
 * vendor material, that the activity appends after the project entries.
 *
 * What is generation's own, and stays here:
 * - Only Proposal and Business Case retrieve it; every other document type
 *   is unchanged.
 * - The organization is the project row's, never the workflow input's. The
 *   project-setup path passes the session's organization, which for a user in
 *   two organizations can be a different tenant than the project's.
 * - The query is the document type's vendor-side intent plus the project's
 *   name, description and goals, so the material is chosen for the project
 *   being proposed, not only for the document type.
 * - The threshold is the project path's, from the project's RAG settings.
 *
 * Everything else — the gate and membership checks (a project guest is not a
 * member, so gets none), the organization's embedding model, the ready-source
 * filter, the live-page check, grouping, the vendor marker, source guidance
 * and neutralization — is the shared search in `company-context-search.ts`.
 *
 * It never throws, and never takes longer than `COMPANY_RETRIEVAL_TIMEOUT_MS`. A failure or a timeout is logged once and
 * yields no company entries, so the author keeps their project context
 * whatever happens here.
 */

import { db, getProjectRagSettings } from "@repo/database";
import { logger } from "@repo/logs";
import { heartbeat } from "@temporalio/activity";
import { searchCompanyContext } from "./company-context-search";

/**
 * The vendor-side question each document type asks of the company context.
 * Only these document types retrieve it; every other type is unchanged.
 */
const COMPANY_CONTEXT_INTENTS: Record<string, string> = {
	PROPOSAL:
		"What relevant experience, case studies, past projects and their outcomes, capabilities, services, delivery approach, methodologies, team expertise, certifications, partnerships and differentiators does our company have for a project like this one?",
	BUSINESS_CASE:
		"What evidence from our company's past work supports a decision about a project like this one: comparable projects and their measured outcomes, delivery track record, capabilities, reusable assets, typical effort, and the risks we have seen?",
};

/** Each project field's share of the query; keeps it inside one embedding input. */
const MAX_PROFILE_FIELD_CHARS = 2000;

/**
 * How long the company half may take before generation goes on without it.
 *
 * It runs inside `retrieveProjectContexts`, after the project half, and the
 * tightest timeout that activity runs under is the task agent's 30-second
 * heartbeat timeout (document generation allows 2 minutes between heartbeats
 * and 15 minutes in all). The company half heartbeats as it starts, so 20
 * seconds from there leaves that heartbeat room to spare, while still
 * covering a slow embedding call and search.
 */
export const COMPANY_RETRIEVAL_TIMEOUT_MS = 20_000;

/** What the reads' race resolves with when the deadline came first. */
const TIMED_OUT = Symbol("company-context-retrieval-timed-out");

function heartbeatCompanyRetrieval(): void {
	heartbeat({ phase: "retrieving_company_context" });
}

interface ProjectProfile {
	name: string;
	description: string | null;
	goals: string | null;
}

function clip(text: string): string {
	return text.length > MAX_PROFILE_FIELD_CHARS
		? text.slice(0, MAX_PROFILE_FIELD_CHARS)
		: text;
}

function buildCompanyContextQuery(
	intent: string,
	project: ProjectProfile,
): string {
	const profile = [
		`Project: ${clip(project.name)}`,
		project.description
			? `Description: ${clip(project.description)}`
			: null,
		project.goals ? `Goals: ${clip(project.goals)}` : null,
	]
		.filter((line): line is string => line !== null)
		.join("\n");
	return `${intent}\n\n${profile}`;
}

/**
 * The project row, which names the organization and gives the query its
 * profile, and its RAG settings, which give the threshold. Read beside each
 * other: a gate that turns out to be off costs the settings read only.
 */
function readProject(projectId: string) {
	return Promise.all([
		db.project.findUnique({
			where: { id: projectId },
			select: {
				organizationId: true,
				name: true,
				description: true,
				goals: true,
			},
		}),
		getProjectRagSettings(projectId),
	]);
}

/**
 * The company context entries for one generation run, or none. Never throws,
 * and gives up `COMPANY_RETRIEVAL_TIMEOUT_MS` after it starts: a hung read,
 * embedding call or search must not hold, or fail, the activity the project
 * entries ride in.
 */
export async function retrieveCompanyContextEntries(input: {
	projectId: string;
	userId: string;
	documentType: string;
}): Promise<string[]> {
	const { projectId, userId } = input;
	const documentType = input.documentType.toUpperCase();
	const intent = COMPANY_CONTEXT_INTENTS[documentType];
	if (!intent) {
		return [];
	}

	// One deadline from the first heartbeat covers the whole company half:
	// the reads below count against it, and the search gets what is left.
	const startedAt = Date.now();
	try {
		heartbeatCompanyRetrieval();
	} catch {
		// Not in an activity context (e.g. tests).
	}

	let reads: Awaited<ReturnType<typeof readProject>> | typeof TIMED_OUT;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		reads = await Promise.race([
			readProject(projectId),
			new Promise<typeof TIMED_OUT>((resolve) => {
				timer = setTimeout(
					() => resolve(TIMED_OUT),
					COMPANY_RETRIEVAL_TIMEOUT_MS,
				);
			}),
		]);
	} catch (error) {
		logger.warn(
			"[CompanyContext] Company context retrieval failed; continuing with project context only",
			{
				projectId,
				documentType,
				error: error instanceof Error ? error.message : String(error),
			},
		);
		return [];
	} finally {
		clearTimeout(timer);
	}
	if (reads === TIMED_OUT) {
		// The reads in flight finish unobserved and are ignored.
		logger.warn(
			"[CompanyContext] Company context retrieval timed out; continuing with project context only",
			{
				projectId,
				documentType,
				timeoutMs: COMPANY_RETRIEVAL_TIMEOUT_MS,
			},
		);
		return [];
	}
	const [project, ragSettings] = reads;
	const organizationId = project?.organizationId;
	if (!project || !organizationId) {
		return [];
	}

	const { entries } = await searchCompanyContext({
		organizationId,
		userId,
		query: buildCompanyContextQuery(intent, project),
		// The project path's threshold, from the same settings.
		minSimilarity: ragSettings.similarityThreshold ?? 0.5,
		timeoutMs: Math.max(
			COMPANY_RETRIEVAL_TIMEOUT_MS - (Date.now() - startedAt),
			0,
		),
		heartbeat: heartbeatCompanyRetrieval,
		projectId,
		logContext: { projectId, documentType },
	});
	return entries.map((entry) => entry.text);
}
