import { commitShaSchema } from "@repo/api/modules/projects/procedures/instructions/repository/commit-sha";
import {
	getDirectRepositoryFileForApi,
	listDirectRepositoryFilesForApi,
} from "@repo/api/modules/v1/instruction-direct-repository";
import {
	INSTRUCTION_FILE_KINDS,
	type InstructionFileKind,
	instructionTextPage,
} from "@repo/instructions";
import { instructionCheckoutCheck } from "./instruction-checkout-check";
import {
	buildChecksReport,
	CHECK_IDS,
	CHECK_TITLES,
	type CheckId,
	type CheckoutFacts,
	type InstructionCheck,
} from "./instruction-checks";
import { resolveGatewayDirectInstructionRead } from "./instruction-direct-repository";
import {
	pageInstructionFiles,
	readInstructionListLimit,
} from "./instruction-list-page";
import type { GatewaySession, ToolCallResult } from "./types";

const INSTRUCTION_PROJECT_DENIED = "Project not found or access denied";

const DIRECT_REPOSITORY_UNAVAILABLE =
	"Coding instructions are configured to read directly from the repository, but the repository is not available right now.";

const DIRECT_REPOSITORY_PAGE_PIN_REQUIRED =
	"Direct repository pages require both generation and commitSha from the first response. Restart from offset 0 to get a new pinned read.";

type DirectToolAccess = {
	ensureInstructionRead: () => Promise<boolean>;
	jsonResult: (data: unknown) => ToolCallResult;
	errorResult: (message: string) => ToolCallResult;
};

export async function handleDirectInstructionChecks(input: {
	projectId: string;
	session: GatewaySession;
	access: DirectToolAccess;
	authCheck: InstructionCheck;
	checkout: CheckoutFacts | undefined;
}): Promise<ToolCallResult | null> {
	const direct = await resolveDirectToolRead(
		input.projectId,
		input.session,
		input.access,
	);
	if (direct.kind === "legacy") return null;
	if (direct.kind === "denied") {
		return input.access.jsonResult(
			buildChecksReport(input.projectId, "mcp", [
				input.authCheck,
				{
					id: "access",
					title: CHECK_TITLES.access,
					status: "fail",
					evidence: "server",
					detail: INSTRUCTION_PROJECT_DENIED,
					fix: {
						description:
							"Check the project ID and this credential's project access, or ask a project maintainer for access.",
					},
				},
				...CHECK_IDS.filter(
					(id) => id !== "auth" && id !== "access",
				).map(
					(id): InstructionCheck => ({
						id,
						title: CHECK_TITLES[id],
						status: "skip",
						evidence: "server",
						detail: "The project is not reachable with this credential.",
					}),
				),
			]),
		);
	}
	const checks: InstructionCheck[] = [
		input.authCheck,
		{
			id: "access",
			title: CHECK_TITLES.access,
			status: "pass",
			evidence: "server",
			detail: "This credential can read the project.",
		},
		{
			id: "published",
			title: "Repository instructions",
			status: direct.kind === "repository" ? "pass" : "warn",
			evidence: "server",
			detail:
				direct.kind === "repository"
					? `Instructions are read directly from Git commit ${direct.state.currentCommitSha}.`
					: "The configured repository is unavailable; no snapshot fallback was used.",
		},
	];
	const resolvers: Partial<Record<CheckId, () => InstructionCheck>> =
		direct.kind === "repository"
			? {
					checkout: () => {
						const { state } = direct;
						return instructionCheckoutCheck({
							facts: input.checkout,
							sourceOfTruth: "REPOSITORY",
							repository: {
								provider: state.repository.provider,
								host: state.repository.host,
								path: state.repository.path,
								ref: state.ref,
								rootPath: state.rootPath,
								generation: state.generation,
								cloneUrl: state.repository.cloneUrl,
							},
							source: {
								kind: "REPOSITORY",
								ref: state.ref,
								commitSha: state.currentCommitSha,
								current: true,
							},
						});
					},
				}
			: {};
	for (const id of CHECK_IDS) {
		if (id === "auth" || id === "access" || id === "published") continue;
		checks.push(
			resolvers[id]?.() ?? {
				id,
				title: CHECK_TITLES[id],
				status: "skip",
				evidence: "server",
				detail: "Direct repository mode uses native Git and the agent's local setup; Fabric does not install or verify a snapshot.",
			},
		);
	}
	return input.access.jsonResult({
		...buildChecksReport(input.projectId, "mcp", checks),
		direct: direct.state,
	});
}

type DirectRepositoryPin = {
	generation: number;
	commitSha: string;
};

type ParsedDirectRepositoryPin =
	| { kind: "missing" }
	| { kind: "valid"; pin: DirectRepositoryPin }
	| { kind: "invalid"; result: ToolCallResult };

function readDirectRepositoryPin(
	args: Record<string, unknown>,
	access: DirectToolAccess,
): ParsedDirectRepositoryPin {
	const generation = args.generation;
	const commitSha = args.commitSha;
	if (generation === undefined && commitSha === undefined) {
		return { kind: "missing" };
	}
	if (
		typeof generation !== "number" ||
		!Number.isInteger(generation) ||
		generation < 0 ||
		typeof commitSha !== "string" ||
		!commitShaSchema.safeParse(commitSha).success
	) {
		return {
			kind: "invalid",
			result: access.errorResult(
				"generation and a full lowercase commitSha must be provided together.",
			),
		};
	}
	return { kind: "valid", pin: { generation, commitSha } };
}

async function resolveDirectToolRead(
	projectId: string,
	session: GatewaySession,
	access: DirectToolAccess,
): Promise<
	| { kind: "legacy" }
	| { kind: "denied"; result: ToolCallResult }
	| {
			kind: "repository";
			state: Extract<
				Awaited<ReturnType<typeof resolveGatewayDirectInstructionRead>>,
				{ kind: "repository" }
			>["state"];
	  }
	| {
			kind: "unavailable";
			state: Extract<
				Awaited<ReturnType<typeof resolveGatewayDirectInstructionRead>>,
				{ kind: "unavailable" }
			>["state"];
	  }
> {
	const direct = await resolveGatewayDirectInstructionRead({
		projectId,
		userId: session.userId,
		ensureInstructionRead: access.ensureInstructionRead,
	});
	if (direct.kind === "denied") {
		return {
			kind: "denied",
			result: access.errorResult(INSTRUCTION_PROJECT_DENIED),
		};
	}
	if (direct.kind === "repository") {
		return direct;
	}
	if (direct.kind === "unavailable") {
		return direct;
	}
	return { kind: "legacy" };
}

function directRepositoryIdentity(state: {
	repository: {
		provider: string;
		host: string;
		path: string;
		cloneUrl: string | null;
	};
	ref: string;
	rootPath: string;
	generation: number;
}) {
	return {
		...state.repository,
		ref: state.ref,
		rootPath: state.rootPath,
		generation: state.generation,
	};
}

export async function handleDirectInstructionList(input: {
	args: Record<string, unknown>;
	projectId: string;
	session: GatewaySession;
	access: DirectToolAccess;
}): Promise<ToolCallResult | null> {
	const direct = await resolveDirectToolRead(
		input.projectId,
		input.session,
		input.access,
	);
	if (direct.kind === "legacy") {
		return null;
	}
	if (direct.kind === "denied") {
		return direct.result;
	}
	if (direct.kind === "unavailable") {
		return input.access.jsonResult({
			snapshot: null,
			direct: direct.state,
			files: [],
			message: DIRECT_REPOSITORY_UNAVAILABLE,
		});
	}
	try {
		const parsedPin = readDirectRepositoryPin(input.args, input.access);
		if (parsedPin.kind === "invalid") {
			return parsedPin.result;
		}
		const pin = parsedPin.kind === "valid" ? parsedPin.pin : undefined;
		const listed = await listDirectRepositoryFilesForApi({
			projectId: input.projectId,
			userId: input.session.userId,
			generation: pin?.generation ?? direct.state.generation,
			commitSha: pin?.commitSha ?? direct.state.currentCommitSha,
		});
		if (!(await input.access.ensureInstructionRead())) {
			return input.access.errorResult(INSTRUCTION_PROJECT_DENIED);
		}
		const kind = input.args.kind as string | undefined;
		if (
			kind !== undefined &&
			!INSTRUCTION_FILE_KINDS.includes(kind as InstructionFileKind)
		) {
			return input.access.errorResult(
				`Unknown kind. Valid kinds: ${INSTRUCTION_FILE_KINDS.join(", ")}`,
			);
		}
		const query = input.args.query as string | undefined;
		const queryFolded = query?.toLocaleLowerCase();
		const limit = readInstructionListLimit(input.args.limit);
		if ("error" in limit) {
			return input.access.errorResult(limit.error);
		}
		const prefix = input.args.prefix;
		if (prefix !== undefined && typeof prefix !== "string") {
			return input.access.errorResult("prefix must be a string.");
		}
		const cursor = input.args.cursor;
		if (cursor !== undefined && typeof cursor !== "string") {
			return input.access.errorResult("cursor must be a string.");
		}
		const paged = pageInstructionFiles({
			files: listed.files.filter(
				(file) =>
					(kind === undefined || file.kind === kind) &&
					(queryFolded === undefined ||
						file.path.toLocaleLowerCase().includes(queryFolded)),
			),
			limit: limit.limit,
			cursor,
			prefix,
			binding: {
				generation: listed.generation,
				commitSha: listed.commitSha,
			},
		});
		if ("error" in paged) {
			return input.access.errorResult(paged.error);
		}
		return input.access.jsonResult({
			snapshot: null,
			repository: directRepositoryIdentity(direct.state),
			direct: {
				commitSha: listed.commitSha,
				generation: listed.generation,
				incomplete: listed.incomplete,
				refusal: listed.refusal,
			},
			files: paged.files,
			page: paged.page,
			message: `These files are read directly from the pinned repository commit; no Fabric snapshot was created.${paged.hint ? ` ${paged.hint}` : ""}`,
		});
	} catch (error) {
		if (!(await input.access.ensureInstructionRead()))
			return input.access.errorResult(INSTRUCTION_PROJECT_DENIED);
		throw error;
	}
}

export async function handleDirectInstructionFile(input: {
	args: Record<string, unknown>;
	projectId: string;
	path: string;
	offset: number;
	maxLength: number;
	session: GatewaySession;
	access: DirectToolAccess;
}): Promise<ToolCallResult | null> {
	const direct = await resolveDirectToolRead(
		input.projectId,
		input.session,
		input.access,
	);
	if (direct.kind === "legacy") {
		return null;
	}
	if (direct.kind === "denied") {
		return direct.result;
	}
	if (direct.kind === "unavailable") {
		return input.access.errorResult(DIRECT_REPOSITORY_UNAVAILABLE);
	}
	try {
		const parsedPin = readDirectRepositoryPin(input.args, input.access);
		if (parsedPin.kind === "invalid") {
			return parsedPin.result;
		}
		const pin = parsedPin.kind === "valid" ? parsedPin.pin : undefined;
		if (input.offset > 0 && pin === undefined) {
			return input.access.errorResult(
				DIRECT_REPOSITORY_PAGE_PIN_REQUIRED,
			);
		}
		const result = await getDirectRepositoryFileForApi({
			projectId: input.projectId,
			userId: input.session.userId,
			generation: pin?.generation ?? direct.state.generation,
			commitSha: pin?.commitSha ?? direct.state.currentCommitSha,
			path: input.path,
		});
		if (!(await input.access.ensureInstructionRead())) {
			return input.access.errorResult(INSTRUCTION_PROJECT_DENIED);
		}
		if (result.read.state !== "found") {
			return input.access.jsonResult({
				path: input.path,
				generation: result.generation,
				commitSha: result.commitSha,
				...result.read,
			});
		}
		return input.access.jsonResult({
			path: input.path,
			generation: result.generation,
			commitSha: result.commitSha,
			state: "found",
			...instructionTextPage(
				result.read.text,
				input.offset,
				input.maxLength,
			),
		});
	} catch (error) {
		if (!(await input.access.ensureInstructionRead()))
			return input.access.errorResult(INSTRUCTION_PROJECT_DENIED);
		throw error;
	}
}

export async function handleDirectInstructionBundle(input: {
	projectId: string;
	session: GatewaySession;
	access: DirectToolAccess;
}): Promise<ToolCallResult | null> {
	const direct = await resolveDirectToolRead(
		input.projectId,
		input.session,
		input.access,
	);
	if (direct.kind === "legacy") {
		return null;
	}
	if (direct.kind === "denied") {
		return direct.result;
	}
	if (direct.kind === "unavailable") {
		return input.access.errorResult(DIRECT_REPOSITORY_UNAVAILABLE);
	}
	return input.access.jsonResult({
		snapshot: null,
		repository: directRepositoryIdentity(direct.state),
		direct: {
			commitSha: direct.state.currentCommitSha,
			generation: direct.state.generation,
		},
		checkout: {
			cloneUrl: direct.state.repository.cloneUrl,
			commitSha: direct.state.currentCommitSha,
			guidance:
				"Use your repository's native Git checkout at this commit. Fabric does not create or serve an instruction archive for direct repositories.",
		},
		message:
			"This project reads coding instructions directly from its repository. Read individual files with fabric_get_project_instruction.",
	});
}
