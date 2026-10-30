/**
 * The synthetic world behind the Proposal artifact procedure tests: two
 * organizations, three projects, one user per access path, and the runs,
 * context rows and answers a test adds. The access paths are listed in
 * `proposal-artifact-harness.ts`, which re-exports everything here.
 *
 * `world` is one object for the whole test file; `resetWorld` restores it in
 * place, so every module holding it sees the reset.
 */

export const ORG_A = "org-a";
export const ORG_B = "org-b";
/** The guest's own workspace: what their session names. */
export const ORG_GUEST = "org-guest";
export const ORG_A_SLUG = "example-org";
export const PROJECT_A = "proj-a";
export const PROJECT_A2 = "proj-a2";
export const PROJECT_B = "proj-b";
export const DOC_A = "doc-a";
export const DOC_A2 = "doc-a2";
export const DOC_B = "doc-b";
export const DOC_PRD = "doc-prd";

export const USERS = {
	owner: "user-owner",
	editor: "user-editor",
	memberViewer: "user-member-viewer",
	memberCommenter: "user-member-commenter",
	guestEditor: "user-guest-editor",
	guestViewer: "user-guest-viewer",
	outsider: "user-outsider",
} as const;

export const USER_NAMES: Record<string, string> = {
	[USERS.owner]: "Olive Owner",
	[USERS.editor]: "Eddie Editor",
	[USERS.memberViewer]: "Vera Viewer",
	[USERS.memberCommenter]: "Cody Commenter",
	[USERS.guestEditor]: "Gale Guest",
	[USERS.guestViewer]: "Gus Guest",
	[USERS.outsider]: "Otto Outsider",
};

export const PROPOSAL_BODY = [
	"# Example Proposal",
	"",
	"## Executive Summary",
	"",
	"We propose a pilot for Example Org.",
	"",
	"## Scope",
	"",
	"The pilot covers the data migration and the reporting dashboard.",
].join("\n");

interface WorldDocument {
	id: string;
	projectId: string;
	type: string;
	content: string;
	/** The generation status; COMPLETE unless a test says. */
	status?: string;
}

export interface WorldFinding {
	id: string;
	title: string;
	stableKey: string | null;
	sectionKey: string | null;
	sectionHash: string | null;
}

/** A stored analysis run, as the access helper's reads see it. */
export interface WorldRun {
	id: string;
	documentId: string;
	organizationId: string;
	proseHash: string | null;
	sourceRunId: string | null;
	findings: WorldFinding[];
}

/** A stored answer, with the columns the response queries select. */
export interface WorldResponse {
	id: string;
	organizationId: string;
	projectId: string;
	documentId: string;
	stableKey: string;
	kind: "CONFIRMED" | "RESPONDED";
	text: string | null;
	findingTitle: string;
	answeredRunId: string;
	sectionKey: string;
	sectionHash: string;
	authorId: string | null;
	version: number;
	createdAt: Date;
	updatedAt: Date;
}

/** A project context row, with the columns the evidence read selects. */
export interface WorldContext {
	projectId: string;
	organizationId: string | null;
	type: string;
	sourceTitle?: string | null;
	originalFilename?: string | null;
	sourcePath?: string | null;
	/** Never read by the evidence: the read selects no address. */
	sourceUrl?: string | null;
	content?: string;
}

/** A company context source row, likewise. */
export interface WorldCompanySource {
	organizationId: string;
	deletingAt: Date | null;
	sourceTitle?: string | null;
	originalFilename?: string | null;
	sourceUrl?: string | null;
	content?: string;
}

interface World {
	projects: Map<
		string,
		{
			organizationId: string | null;
			userId: string;
			deletedAt: Date | null;
		}
	>;
	organizations: Map<string, { slug: string | null }>;
	documents: Map<string, WorldDocument>;
	/** `${organizationId}:${userId}` → org role. */
	orgMembers: Map<string, string>;
	/** `${projectId}:${userId}` → project role (accepted, not expiring). */
	projectMembers: Map<string, string>;
	/** The PROPOSAL_ARTIFACT rollout gate, per organization. */
	flags: Map<string, boolean>;
	runs: Map<string, WorldRun>;
	/** Project context rows by id, as they are now. */
	contexts: Map<string, WorldContext>;
	/** Company context sources by id, as they are now. */
	companySources: Map<string, WorldCompanySource>;
	responses: WorldResponse[];
}

function createWorld(): World {
	const document = (
		id: string,
		projectId: string,
		overrides: Partial<WorldDocument> = {},
	): [string, WorldDocument] => [
		id,
		{
			id,
			projectId,
			type: "PROPOSAL",
			content: PROPOSAL_BODY,
			...overrides,
		},
	];
	return {
		projects: new Map([
			[
				PROJECT_A,
				{ organizationId: ORG_A, userId: USERS.owner, deletedAt: null },
			],
			[
				PROJECT_A2,
				{ organizationId: ORG_A, userId: USERS.owner, deletedAt: null },
			],
			[
				PROJECT_B,
				{
					organizationId: ORG_B,
					userId: USERS.outsider,
					deletedAt: null,
				},
			],
		]),
		organizations: new Map([
			[ORG_A, { slug: ORG_A_SLUG }],
			[ORG_B, { slug: "example-other-org" }],
		]),
		documents: new Map([
			document(DOC_A, PROJECT_A),
			document(DOC_A2, PROJECT_A2),
			document(DOC_B, PROJECT_B),
			document(DOC_PRD, PROJECT_A, { type: "PRD" }),
		]),
		orgMembers: new Map([
			[`${ORG_A}:${USERS.owner}`, "owner"],
			[`${ORG_A}:${USERS.editor}`, "member"],
			[`${ORG_A}:${USERS.memberViewer}`, "member"],
			[`${ORG_A}:${USERS.memberCommenter}`, "member"],
			[`${ORG_B}:${USERS.outsider}`, "owner"],
			[`${ORG_GUEST}:${USERS.guestEditor}`, "owner"],
			[`${ORG_GUEST}:${USERS.guestViewer}`, "owner"],
		]),
		projectMembers: new Map([
			[`${PROJECT_A}:${USERS.editor}`, "EDITOR"],
			[`${PROJECT_A}:${USERS.memberViewer}`, "VIEWER"],
			[`${PROJECT_A}:${USERS.memberCommenter}`, "COMMENTER"],
			[`${PROJECT_A}:${USERS.guestEditor}`, "EDITOR"],
			[`${PROJECT_A}:${USERS.guestViewer}`, "VIEWER"],
		]),
		flags: new Map([
			[ORG_A, true],
			[ORG_B, true],
		]),
		runs: new Map(),
		contexts: new Map(),
		companySources: new Map(),
		responses: [],
	};
}

export const world: World = createWorld();

export function resetWorld(): void {
	Object.assign(world, createWorld());
}
