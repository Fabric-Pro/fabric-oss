/**
 * The chat prompt of a client Proposal, resolved on the server (Fizzy #2946).
 *
 * CopilotKit hands the agent only the browser's run input plus the agent
 * headers; the runtime's `properties` never reach it. So for every
 * `agent/run` the route resolves what the chat may do on this document and
 * REWRITES the run input before the runtime sees it. agent-core spreads
 * `forwardedProps` into the agent's `configurable`, so the values written here
 * reach the chat node as config.
 *
 * - Server keys are always written and client keys always removed: a browser
 *   can neither choose the mode nor supply the prompt, the settled block, the
 *   echo text or who it is reading as.
 * - The prompt and the block go into `forwardedProps`, never into `state`:
 *   the agent's state snapshots echo every state field back to the browser.
 * - An artifact run carries no client text the agent would set beside the
 *   bound prompt (a prompt, a skill, a topic, attachments, project context);
 *   the project id it keeps is the verified document's. The chat's
 *   attachments move to `proposal_attachments`, which the agent sets only in
 *   the person's own turn.
 * - Nothing is cached: resolution runs once per run, never on the handshake
 *   calls (`info`, `agent/connect`).
 * - The clarifying-question policy goes into `forwardedProps` too: the agent
 *   binds the clarifying-question card with it in place of the browser's.
 * - Logs carry ids and codes only, never prompt, block or carried text.
 */

import {
	db,
	getBoundPromptForAgent,
	hasProjectAccess,
	isOrganizationMember,
	isProposalClientDocument,
} from "@repo/database";
import { logger } from "@repo/logs";
import {
	findBoundProposalPrompt,
	loadBoundProposalPromptText,
} from "@repo/temporal/proposal-artifact-prompts";
import { buildSettledDecisionsBlock } from "@repo/temporal/proposal-artifact-settled-decisions";
import {
	type ClarifyingQuestionFrequency,
	clarifyingQuestionPolicy,
} from "@repo/utils/editor-frontend-actions";
import { PROPOSAL_CLIENT_REVISION_AGENT_KEY } from "@repo/utils/prompt-action-catalog";
import type { CarriedSettledText } from "@repo/utils/proposal-artifact/response-echo";

const LOG_PREFIX = "[CopilotKit] Proposal chat";

/**
 * - `none`: not a client Proposal; the chat behaves as it always has.
 * - `artifact`: a verified client Proposal with its revision prompt bound.
 * - `unbound`: a verified client Proposal with no revision prompt bound; the
 *   agent offers no write tools and says what to bind.
 * - `unverified`: the state says Proposal but no document id arrived (a
 *   bundle from before the route knew the document); no write tools, and a
 *   reply asking the person to reload.
 */
type ProposalRunMode = "none" | "artifact" | "unbound" | "unverified";

type ProposalEchoCarried = Pick<
	CarriedSettledText,
	"responseTexts" | "findingTitles"
>;

/**
 * Who is reading an artifact run's document, judged in the project's OWNING
 * organization: `member` for a member of it, `guest` for a project guest.
 */
type ProposalViewer = "member" | "guest";

interface ProposalRunConfig {
	mode: ProposalRunMode;
	clientPrompt: string | null;
	settledBlock: string | null;
	echoCarried: ProposalEchoCarried | null;
	/** Set for an `artifact` run only; null in every other mode. */
	viewer: ProposalViewer | null;
	/**
	 * The verified document's project, for an `artifact` run only: the run's
	 * project id is this one, never the browser's.
	 */
	projectId: string | null;
	/**
	 * The project's clarifying-question policy as the person's editor reads
	 * it, for an `artifact` run only (`resolveClarifyingPolicy`).
	 */
	clarifyingPolicy: string | null;
}

type ProposalRunResolution =
	| { ok: true; config: ProposalRunConfig }
	| { ok: false; status: 403 | 500; code: string };

/**
 * Every `forwardedProps` key the route owns; a client value never survives.
 * `proposal_attachments` is the one written from the client's own input: the
 * chat's attachments, moved there from the readable and state the agent
 * builds its system prompt from, so the agent can set them in the person's
 * turn instead.
 */
export const PROPOSAL_FORWARDED_PROP_KEYS = [
	"proposal_mode",
	"proposal_client_prompt",
	"proposal_settled_block",
	"proposal_echo_carried",
	"proposal_viewer",
	"proposal_attachments",
	"proposal_clarifying_policy",
] as const;

/**
 * State fields that would steer an artifact run past the bound prompt, or set
 * client text beside it. Only stripped for artifact runs: StoryWorkspace
 * legitimately sends a server-resolved prompt through state, and the other
 * chats send their attachments and project this way on purpose.
 * `publishingTopic` is the agent's own field for the topic section; the topic
 * itself arrives as a readable, stripped below. `ragContexts` and
 * `refreshSpecContexts` carry attachment and project text, `projectContext`
 * the project's name, description and stack.
 */
const ARTIFACT_RUN_STRIPPED_STATE_KEYS = [
	"systemPrompt",
	"suppressFabricMethodology",
	"activeSkill",
	"publishingTopic",
	"ragContexts",
	"refreshSpecContexts",
	"projectContext",
] as const;

/**
 * Readables (`context` entries) that would steer an artifact run, matched as
 * the project document agent finds them: a description containing the text,
 * in any case. The publishing topic is appended to the agent's system prompt,
 * and the rag context (the chat's attachments) joins it; an artifact run
 * carries the attachments in `proposal_attachments` instead. Only stripped
 * for artifact runs: the Publishing Suite's topic assistant and the other
 * chats send them on purpose.
 */
const ARTIFACT_RUN_STRIPPED_READABLES = [
	"publishing topic",
	"rag context",
] as const;

/** The readable that carries the chat's attachments, matched the same way. */
const ATTACHMENTS_READABLE = "rag context";

/**
 * The readable that carries the project, matched the same way. Its project id
 * and integration flags choose the agent's tools; its `projectContext` (name,
 * description, stack) joined the prompt. An artifact run keeps the flags,
 * takes the project id from the verified document and loses the text.
 */
const PROJECT_READABLE = "project context";

/** The integration flags the project readable keeps on an artifact run. */
const PROJECT_READABLE_FLAGS = [
	"hasTeamsIntegration",
	"hasSlackIntegration",
	"hasGitHubIntegration",
	"hasRepoIntegration",
] as const;

const NONE: ProposalRunConfig = {
	mode: "none",
	clientPrompt: null,
	settledBlock: null,
	echoCarried: null,
	viewer: null,
	projectId: null,
	clarifyingPolicy: null,
};

interface SingleRouteEnvelope {
	method?: unknown;
	params?: unknown;
	body?: unknown;
}

/**
 * The single-route `{ method, params, body }` envelope, read from a clone so
 * the runtime can still read the original; null when the body is not JSON.
 */
export async function readSingleRouteEnvelope(
	req: Request,
): Promise<SingleRouteEnvelope | null> {
	try {
		const parsed = JSON.parse(await req.clone().text()) as unknown;
		return isRecord(parsed) ? (parsed as SingleRouteEnvelope) : null;
	} catch {
		return null;
	}
}

/**
 * What this run may do on its document.
 *
 * With a `documentId`: the document's project must be owned by the requested
 * organization and the session user must have access to it, or the run is
 * refused with a 403 before anything else is read. A Proposal is judged by
 * its OWNING organization's gate, so a guest is never judged by their own.
 *
 * Fails closed with a 500 when the gate or the prompt cannot be read: mapping
 * an error to `none` would hand a possible client document the default prompt
 * and every write tool, and `unbound` would tell the person to bind a prompt
 * that may well be bound.
 */
export async function resolveProposalRunConfig(args: {
	documentId: string | null;
	organizationId: string | undefined;
	userId: string;
	state: unknown;
}): Promise<ProposalRunResolution> {
	const { documentId, organizationId, userId } = args;
	if (!documentId) {
		return {
			ok: true,
			config: stateSaysProposal(args.state)
				? { ...NONE, mode: "unverified" }
				: NONE,
		};
	}

	const forbidden = (reason: string): ProposalRunResolution => {
		logger.warn(`${LOG_PREFIX} refused`, {
			userId,
			organizationId,
			documentId,
			reason,
		});
		return { ok: false, status: 403, code: "FORBIDDEN" };
	};

	let stage = "document";
	try {
		const document = await db.projectDocument.findFirst({
			where: { id: documentId },
			select: {
				type: true,
				projectId: true,
				project: {
					select: {
						organizationId: true,
						deletedAt: true,
						clarifyingQuestionFrequency: true,
					},
				},
			},
		});
		// Not found and forbidden answer the same, so the answer reveals
		// nothing about a document the caller cannot see.
		if (!document || document.project.deletedAt) {
			return forbidden("document-not-found");
		}
		const owningOrganizationId = document.project.organizationId;
		if (!owningOrganizationId || owningOrganizationId !== organizationId) {
			return forbidden("organization-mismatch");
		}
		stage = "access";
		if (!(await hasProjectAccess(document.projectId, userId))) {
			return forbidden("no-project-access");
		}

		stage = "gate";
		if (
			!(await isProposalClientDocument({
				organizationId: owningOrganizationId,
				documentType: document.type,
			}))
		) {
			return { ok: true, config: NONE };
		}

		stage = "prompt";
		const [clientPrompt, settled, viewerIsMember] = await Promise.all([
			loadBoundRevisionPrompt({
				userId,
				organizationId: owningOrganizationId,
				projectId: document.projectId,
				documentId,
			}),
			// Null for a guest: settled decisions never reach a reader outside
			// the owning organization.
			buildSettledDecisionsBlock({
				projectId: document.projectId,
				documentId,
				starterUserId: userId,
				organizationId: owningOrganizationId,
			}),
			// The owning organization's membership only: a member of another
			// organization reading this project is a guest here.
			isOrganizationMember(userId, owningOrganizationId),
		]);
		if (clientPrompt === null) {
			logger.info(`${LOG_PREFIX} revision prompt not bound`, {
				organizationId: owningOrganizationId,
				projectId: document.projectId,
				documentId,
			});
			return { ok: true, config: { ...NONE, mode: "unbound" } };
		}

		const viewer: ProposalViewer = viewerIsMember ? "member" : "guest";
		const clarifyingPolicy = await resolveClarifyingPolicy({
			frequency: document.project.clarifyingQuestionFrequency,
			viewer,
			userId,
			organizationId: owningOrganizationId,
			documentId,
		});

		// The proposed document must not reproduce the prompt, nor, for a
		// member, any settled answer the block carried.
		const echoCarried: ProposalEchoCarried = {
			responseTexts: [
				...(settled?.carried.responseTexts ?? []),
				clientPrompt,
			],
			findingTitles: settled?.carried.findingTitles ?? [],
		};

		return {
			ok: true,
			config: {
				mode: "artifact",
				clientPrompt,
				settledBlock: settled?.block ?? null,
				echoCarried,
				viewer,
				projectId: document.projectId,
				clarifyingPolicy,
			},
		};
	} catch (error) {
		logger.error(`${LOG_PREFIX} resolution failed`, {
			userId,
			organizationId,
			documentId,
			stage,
			error: error instanceof Error ? error.name : "unknown",
		});
		return {
			ok: false,
			status: 500,
			code: "PROPOSAL_CHAT_RESOLUTION_FAILED",
		};
	}
}

/**
 * The text of the bound `proposal_client_revision` prompt, at the version the
 * binding points at, or null when nothing usable is bound.
 *
 * Read by `loadBoundProposalPromptText`, as applying a finding reads it, so
 * the chat and the finding revision hand the model the same text: no
 * variables, no escaping, trimmed, and without generation's formatting and
 * project-context appendices, since the chat agent composes its own system
 * message around it. The resolver skips the personal tier for this
 * client-only action.
 */
async function loadBoundRevisionPrompt(args: {
	userId: string;
	organizationId: string;
	projectId: string;
	documentId: string;
}): Promise<string | null> {
	const bound = await findBoundProposalPrompt({
		userId: args.userId,
		organizationId: args.organizationId,
		projectId: args.projectId,
		action: PROPOSAL_CLIENT_REVISION_AGENT_KEY,
	});
	if (!bound) {
		return null;
	}
	const text = await loadBoundProposalPromptText({
		promptVersionId: bound.promptVersionId,
		organizationId: args.organizationId,
	});
	if (text === null) {
		logger.warn(`${LOG_PREFIX} bound prompt version unavailable`, {
			organizationId: args.organizationId,
			documentId: args.documentId,
			promptId: bound.promptId,
			promptVersionId: bound.promptVersionId,
		});
	}
	return text;
}

/**
 * The project's clarifying-question policy as the person's editor reads it
 * (`useClarifyingQuestions`), for the card the agent binds in place of the
 * browser's. A member reads the `clarifying_questions` prompt bound for the
 * project's tier, by the lookup `prompts.agents.clarifyingPolicy` makes, and
 * the tier's built-in text when none is bound. A project guest cannot read
 * the owning organization's Prompt Library, so their editor, and this run,
 * use the built-in text. A failed lookup falls back to the built-in text too,
 * as the editor's does: the policy never blocks a run.
 */
async function resolveClarifyingPolicy(args: {
	frequency: ClarifyingQuestionFrequency | null | undefined;
	viewer: ProposalViewer;
	userId: string;
	organizationId: string;
	documentId: string;
}): Promise<string> {
	const frequency = args.frequency ?? "BALANCED";
	const builtIn = clarifyingQuestionPolicy(frequency);
	if (args.viewer !== "member") {
		return builtIn;
	}
	try {
		const prompt = await getBoundPromptForAgent({
			agentName: "clarifying_questions",
			documentType: frequency,
			storyKind: null,
			userId: args.userId,
			organizationId: args.organizationId,
		});
		return prompt?.version?.content?.trim() || builtIn;
	} catch (error) {
		logger.warn(`${LOG_PREFIX} clarifying policy unavailable`, {
			organizationId: args.organizationId,
			documentId: args.documentId,
			error: error instanceof Error ? error.name : "unknown",
		});
		return builtIn;
	}
}

/**
 * The run input with every route-owned `forwardedProps` key replaced by the
 * server's value. For an artifact run the steering and text-bearing state
 * fields and readables are removed, the chat's attachments move to
 * `proposal_attachments`, the project readable keeps only the verified
 * project id and the integration flags, and the state's project id is always
 * the verified one, set even when the client sent none. Never adds a
 * `context` or a readable the client did not send.
 */
export function rewriteAgentRunBody(
	body: Record<string, unknown>,
	config: ProposalRunConfig,
): Record<string, unknown> {
	const forwardedProps: Record<string, unknown> = isRecord(
		body.forwardedProps,
	)
		? { ...body.forwardedProps }
		: {};
	for (const key of PROPOSAL_FORWARDED_PROP_KEYS) {
		delete forwardedProps[key];
	}
	forwardedProps.proposal_mode = config.mode;
	forwardedProps.proposal_client_prompt = config.clientPrompt;
	forwardedProps.proposal_settled_block = config.settledBlock;
	forwardedProps.proposal_echo_carried = config.echoCarried;
	forwardedProps.proposal_viewer = config.viewer;
	forwardedProps.proposal_attachments =
		config.mode === "artifact" ? readAttachments(body) : null;
	forwardedProps.proposal_clarifying_policy = config.clarifyingPolicy;

	const rewritten: Record<string, unknown> = { ...body, forwardedProps };
	if (config.mode === "artifact") {
		const state: Record<string, unknown> = isRecord(body.state)
			? { ...body.state }
			: {};
		for (const key of ARTIFACT_RUN_STRIPPED_STATE_KEYS) {
			delete state[key];
		}
		// Always the verified project, sent or not: the agent's project
		// knowledge tools read it from state.
		state.projectId = config.projectId;
		rewritten.state = state;
	}
	if (config.mode === "artifact" && Array.isArray(body.context)) {
		rewritten.context = body.context.flatMap((readable) => {
			const description = readableDescription(readable);
			if (
				description !== null &&
				ARTIFACT_RUN_STRIPPED_READABLES.some((text) =>
					description.includes(text),
				)
			) {
				return [];
			}
			if (description?.includes(PROJECT_READABLE)) {
				const kept = idOnlyProjectReadable(
					readable as Record<string, unknown>,
					config.projectId,
				);
				return kept ? [kept] : [];
			}
			return [readable];
		});
	}
	return rewritten;
}

/**
 * The chat's attachments as the agent reads them: the attachments readable's
 * entries when it has any, else the state's mirror of them (it covers a
 * readable that arrived stale). Strings only; none when neither has any.
 */
function readAttachments(body: Record<string, unknown>): string[] {
	const readable = Array.isArray(body.context)
		? body.context.find((entry) =>
				readableDescription(entry)?.includes(ATTACHMENTS_READABLE),
			)
		: undefined;
	let value: unknown = isRecord(readable) ? readable.value : undefined;
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			value = undefined;
		}
	}
	const fromReadable = isRecord(value)
		? stringEntries(value.ragContexts)
		: [];
	if (fromReadable.length > 0) {
		return fromReadable;
	}
	return isRecord(body.state) ? stringEntries(body.state.ragContexts) : [];
}

function stringEntries(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter(
				(entry): entry is string =>
					typeof entry === "string" && entry.trim().length > 0,
			)
		: [];
}

/** A readable's description in lower case, as the agent matches it. */
function readableDescription(readable: unknown): string | null {
	return isRecord(readable) && typeof readable.description === "string"
		? readable.description.toLowerCase()
		: null;
}

/**
 * The project readable with only the verified project id and the integration
 * flags the client sent as booleans, its value in the form it arrived in
 * (AG-UI sends JSON text). Null, so the readable is dropped, when there is no
 * verified id or the value cannot be read.
 */
function idOnlyProjectReadable(
	readable: Record<string, unknown>,
	projectId: string | null,
): Record<string, unknown> | null {
	if (!projectId) {
		return null;
	}
	const sent = readable.value;
	let value: unknown = sent;
	if (typeof sent === "string") {
		try {
			value = JSON.parse(sent);
		} catch {
			return null;
		}
	}
	if (!isRecord(value)) {
		return null;
	}
	const kept: Record<string, unknown> = { projectId };
	for (const flag of PROJECT_READABLE_FLAGS) {
		if (typeof value[flag] === "boolean") {
			kept[flag] = value[flag];
		}
	}
	return {
		...readable,
		value: typeof sent === "string" ? JSON.stringify(kept) : kept,
	};
}

/**
 * A call that resolves nothing, with any client-sent value for a
 * route-owned `forwardedProps` key removed; the same object when there is
 * none to remove.
 */
export function withoutClientProposalProps(
	body: Record<string, unknown>,
): Record<string, unknown> {
	const sent = body.forwardedProps;
	if (
		!isRecord(sent) ||
		!PROPOSAL_FORWARDED_PROP_KEYS.some((key) => key in sent)
	) {
		return body;
	}
	const forwardedProps = { ...sent };
	for (const key of PROPOSAL_FORWARDED_PROP_KEYS) {
		delete forwardedProps[key];
	}
	return { ...body, forwardedProps };
}

/**
 * The request the runtime reads, carrying `envelope` instead of the
 * original body. Mirrors the runtime's own re-serialization: the length
 * header goes (the body changed) and the abort signal stays.
 */
export function withEnvelope(
	req: Request,
	envelope: SingleRouteEnvelope,
): Request {
	const headers = new Headers(req.headers);
	headers.set("content-type", "application/json");
	headers.delete("content-length");
	return new Request(req.url, {
		method: req.method,
		headers,
		body: JSON.stringify(envelope),
		signal: req.signal,
	});
}

/** A document id worth querying: non-empty, bounded, id-shaped. */
export function readDocumentIdParam(url: URL): string | null {
	const value = url.searchParams.get("documentId")?.trim();
	return value && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;
}

function stateSaysProposal(state: unknown): boolean {
	return (
		isRecord(state) &&
		typeof state.documentType === "string" &&
		state.documentType.toLowerCase() === "proposal"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
