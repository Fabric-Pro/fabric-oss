import { ORPCError } from "@orpc/client";
import { resolveCurrentInstructionSource } from "@repo/database";
import { instructionTextPage } from "@repo/instructions";
import type { Context, Hono } from "hono";
import { requireScope } from "../external-api/middleware/api-key-auth";
import type { ExternalApiVariables } from "../external-api/types";
import { badRequest, ok } from "./helpers";
import { instructionRepositoryDirectUpgradeNotice } from "./instruction-cli-compatibility";
import {
	directRepositoryAvailability,
	getDirectRepositoryFileForApi,
	getDirectRepositoryState,
	listDirectRepositoryFilesForApi,
} from "./instruction-direct-repository";
import { resolveInstructionProject } from "./instruction-project-gate";

const DIRECT_FILE_BODY_DEFAULT_MAX = 50_000;

const DIRECT_FILE_BODY_MAX = 200_000;

type DirectPinQuery =
	| { generation: number; commitSha: string }
	| { generation?: undefined; commitSha?: undefined }
	| { error: string };

type CurrentInstructionSource = Awaited<
	ReturnType<typeof resolveCurrentInstructionSource>
>;

function sameCurrentInstructionSource(
	first: CurrentInstructionSource,
	second: CurrentInstructionSource,
): boolean {
	if (first.sourceOfTruth !== second.sourceOfTruth) {
		return false;
	}
	if (first.repository === null || second.repository === null) {
		return first.repository === second.repository;
	}
	return (
		first.repository.provider === second.repository.provider &&
		first.repository.host === second.repository.host &&
		first.repository.path === second.repository.path &&
		first.repository.ref === second.repository.ref &&
		first.repository.rootPath === second.repository.rootPath &&
		first.repository.generation === second.repository.generation &&
		first.repository.cloneUrl === second.repository.cloneUrl
	);
}

function parseDirectPinQuery(
	generation: string | undefined,
	commitSha: string | undefined,
	required: boolean,
): DirectPinQuery {
	if (generation === undefined && commitSha === undefined && !required) {
		return {};
	}
	if (
		generation === undefined ||
		commitSha === undefined ||
		!/^\d+$/.test(generation) ||
		!Number.isSafeInteger(Number(generation)) ||
		!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commitSha)
	) {
		return {
			error: "generation and a full lowercase commitSha must be provided together.",
		};
	}
	return { generation: Number(generation), commitSha };
}

function parseDirectNumber(
	raw: string | undefined,
	defaultValue: number,
	max: number,
): number | null {
	if (raw === undefined) {
		return defaultValue;
	}
	return /^\d+$/.test(raw) &&
		Number.isSafeInteger(Number(raw)) &&
		Number(raw) <= max
		? Number(raw)
		: null;
}

function directReadErrorCode(
	error: ORPCError<string, unknown>,
	fallback: string,
): string {
	const data = error.data;
	return typeof data === "object" &&
		data !== null &&
		"code" in data &&
		typeof data.code === "string"
		? data.code
		: fallback;
}

function directReadFailure(error: unknown): {
	status: 400 | 403 | 404 | 409 | 503;
	body: { error: { message: string; code: string } };
} {
	if (error instanceof ORPCError) {
		switch (error.code) {
			case "BAD_REQUEST": {
				const badRequestCode = directReadErrorCode(
					error,
					"REPOSITORY_INVALID_REQUEST",
				);
				return {
					status: 400,
					body: {
						error: {
							message: "Repository request was refused.",
							code: badRequestCode,
						},
					},
				};
			}
			case "FORBIDDEN": {
				const forbiddenCode = directReadErrorCode(
					error,
					"PROJECT_ACCESS_FORBIDDEN",
				);
				return {
					status: 403,
					body: {
						error: {
							message: "Repository access was refused.",
							code: forbiddenCode,
						},
					},
				};
			}
			case "NOT_FOUND": {
				const notFoundCode = directReadErrorCode(
					error,
					"PROJECT_NOT_FOUND",
				);
				return {
					status: 404,
					body: {
						error: {
							message: "Repository file or commit was not found.",
							code: notFoundCode,
						},
					},
				};
			}
			case "CONFLICT": {
				const conflictCode = directReadErrorCode(
					error,
					"REPOSITORY_CONFIGURATION_CHANGED",
				);
				return {
					status: 409,
					body: {
						error: {
							message:
								"Repository configuration changed. Refresh and try again.",
							code: conflictCode,
						},
					},
				};
			}
		}
	}
	switch (directRepositoryAvailability(error)) {
		case "NOT_FOUND":
			return {
				status: 404,
				body: {
					error: {
						message: "Repository commit not found",
						code: "COMMIT_NOT_FOUND",
					},
				},
			};
		case "MIGRATING":
			return {
				status: 409,
				body: {
					error: {
						message: "Repository migration is still in progress.",
						code: "INSTRUCTION_MIGRATION_IN_PROGRESS",
					},
				},
			};
		default:
			return {
				status: 503,
				body: {
					error: {
						message:
							"Couldn't read coding instructions from the repository.",
						code: "REPOSITORY_UNAVAILABLE",
					},
				},
			};
	}
}

export async function directPublishedResponse(
	c: Context<{ Variables: ExternalApiVariables }>,
	projectId: string,
	userId: string,
	current: CurrentInstructionSource,
) {
	let direct: Awaited<ReturnType<typeof getDirectRepositoryState>>;
	try {
		direct = await getDirectRepositoryState({
			projectId,
			userId: userId,
			signal: c.req.raw.signal,
		});
	} catch (error) {
		const failure = directReadFailure(error);
		return c.json(failure.body, failure.status);
	}
	const upgradeNotice = instructionRepositoryDirectUpgradeNotice(
		c.req.header("user-agent"),
	);
	if (
		upgradeNotice &&
		(direct.availability === "READY" ||
			(current.sourceOfTruth === "REPOSITORY" &&
				direct.availability !== "MIGRATING"))
	) {
		c.header("X-Fabric-Cli-Upgrade", upgradeNotice);
		return c.json(
			{
				error: {
					message: upgradeNotice,
					code: "CLI_UPGRADE_REQUIRED",
				},
			},
			409,
		);
	}
	if (direct.availability === "READY") {
		return c.json(
			ok({
				published: false,
				sourceOfTruth: "REPOSITORY" as const,
				repository: {
					...direct.repository,
					ref: direct.ref,
					rootPath: direct.rootPath,
					generation: direct.generation,
				},
				direct,
			}),
		);
	}
	if (
		current.sourceOfTruth === "REPOSITORY" &&
		direct.availability !== "MIGRATING"
	) {
		const rechecked = await resolveInstructionProject(
			projectId,
			c.get("externalApiContext"),
			{
				org: c.req.query("org"),
				personal: c.req.query("personal") === "1",
			},
		);
		if ("error" in rechecked) {
			return c.json({ error: rechecked.error }, rechecked.status);
		}
		const currentAfterDirectRead = await resolveCurrentInstructionSource(
			projectId,
			rechecked.organizationId,
		);
		if (!sameCurrentInstructionSource(current, currentAfterDirectRead)) {
			return c.json(
				{
					error: {
						message:
							"Repository settings changed while their current state was being read. Refresh and try again.",
						code: "REPOSITORY_CONFIGURATION_CHANGED",
					},
				},
				409,
			);
		}
		return c.json(
			ok({
				published: false,
				sourceOfTruth: currentAfterDirectRead.sourceOfTruth,
				repository: currentAfterDirectRead.repository,
				direct,
			}),
		);
	}
	return null;
}

export function registerDirectInstructionRepositoryRoutes(
	app: Hono<{ Variables: ExternalApiVariables }>,
) {
	app.get(
		"/projects/:projectId/instructions/repository",
		requireScope("instructions:read"),
		async (c) => {
			const projectId = c.req.param("projectId")!;
			const resolved = await resolveInstructionProject(
				projectId,
				c.get("externalApiContext"),
				{
					org: c.req.query("org"),
					personal: c.req.query("personal") === "1",
				},
			);
			if ("error" in resolved) {
				return c.json({ error: resolved.error }, resolved.status);
			}
			try {
				return c.json(
					ok(
						await getDirectRepositoryState({
							projectId,
							userId: resolved.userId,
							signal: c.req.raw.signal,
						}),
					),
				);
			} catch (error) {
				const failure = directReadFailure(error);
				return c.json(failure.body, failure.status);
			}
		},
	);

	app.get(
		"/projects/:projectId/instructions/repository/files",
		requireScope("instructions:read"),
		async (c) => {
			const parsedPin = parseDirectPinQuery(
				c.req.query("generation"),
				c.req.query("commitSha"),
				false,
			);
			if ("error" in parsedPin) {
				return c.json(badRequest(parsedPin.error), 400);
			}
			const projectId = c.req.param("projectId")!;
			const resolved = await resolveInstructionProject(
				projectId,
				c.get("externalApiContext"),
				{
					org: c.req.query("org"),
					personal: c.req.query("personal") === "1",
				},
			);
			if ("error" in resolved) {
				return c.json({ error: resolved.error }, resolved.status);
			}
			try {
				return c.json(
					ok(
						await listDirectRepositoryFilesForApi({
							projectId,
							userId: resolved.userId,
							signal: c.req.raw.signal,
							...parsedPin,
						}),
					),
				);
			} catch (error) {
				const failure = directReadFailure(error);
				return c.json(failure.body, failure.status);
			}
		},
	);

	app.get(
		"/projects/:projectId/instructions/repository/file",
		requireScope("instructions:read"),
		async (c) => {
			const parsedPin = parseDirectPinQuery(
				c.req.query("generation"),
				c.req.query("commitSha"),
				true,
			);
			const path = c.req.query("path");
			const offset = parseDirectNumber(
				c.req.query("offset"),
				0,
				Number.MAX_SAFE_INTEGER,
			);
			const maxLength = parseDirectNumber(
				c.req.query("maxLength"),
				DIRECT_FILE_BODY_DEFAULT_MAX,
				DIRECT_FILE_BODY_MAX,
			);
			if (
				"error" in parsedPin ||
				typeof path !== "string" ||
				path.length === 0 ||
				offset === null ||
				maxLength === null ||
				maxLength === 0
			) {
				return c.json(
					badRequest(
						"path, generation, commitSha, offset and maxLength must be valid repository file parameters.",
					),
					400,
				);
			}
			if (
				parsedPin.generation === undefined ||
				parsedPin.commitSha === undefined
			) {
				return c.json(
					badRequest(
						"generation and commitSha must be provided for repository file reads.",
					),
					400,
				);
			}
			const projectId = c.req.param("projectId")!;
			const resolved = await resolveInstructionProject(
				projectId,
				c.get("externalApiContext"),
				{
					org: c.req.query("org"),
					personal: c.req.query("personal") === "1",
				},
			);
			if ("error" in resolved) {
				return c.json({ error: resolved.error }, resolved.status);
			}
			try {
				const result = await getDirectRepositoryFileForApi({
					projectId,
					userId: resolved.userId,
					signal: c.req.raw.signal,
					generation: parsedPin.generation,
					commitSha: parsedPin.commitSha,
					path,
				});
				if (result.read.state !== "found") {
					return c.json(ok({ ...result, ...result.read }));
				}
				return c.json(
					ok({
						generation: result.generation,
						commitSha: result.commitSha,
						state: "found",
						...instructionTextPage(
							result.read.text,
							offset,
							maxLength,
						),
					}),
				);
			} catch (error) {
				const failure = directReadFailure(error);
				return c.json(failure.body, failure.status);
			}
		},
	);
}
