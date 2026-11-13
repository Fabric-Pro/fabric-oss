import { ORPCError } from "@orpc/client";
import { config } from "@repo/config";
import {
	createDerivedInstructionSnapshot,
	createInstructionSnapshot,
	getInstructionSnapshot,
	getProjectInstructionSettings,
	getPublishedInstructionSnapshot,
	listInstructionFiles,
} from "@repo/database";
import {
	mergeExcludedPaths,
	readFrozenIgnoreGlobs,
	resolveIgnoreGlobs,
	SNAPSHOT_LIMITS,
	snapshotPrefix,
} from "@repo/instructions";
import { getStorageProvider } from "@repo/storage";
import { z } from "zod";
import {
	type AuditRequestContext,
	recordAuditFromRequest,
} from "../../../../lib/audit";
import { projectNotFoundUnlessVisible } from "../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	derivedSnapshotRefusal,
	planTemplateAdditions,
	type TemplateSkipReason,
} from "./change-set";
import { requireHostingOrganizationId } from "./hosting-organization";
import { migrationOpenError } from "./migration-freeze";
import {
	listTemplateFiles,
	readOrganizationTemplate,
} from "./organization-template";
import { stageAndFinalizeInstructionSnapshot } from "./stage-and-finalize";
import { versionContentionAsConflict } from "./version-contention";

const SKILLS_BUCKET = config.storage.bucketNames.skills;

/**
 * How many template objects are copied inside storage at once. A copy moves
 * no bytes through this process, so the bound is about the storage API's
 * request rate, not memory.
 */
const TEMPLATE_COPY_CONCURRENCY = 8;

type ApplyTemplateResult = {
	/** The new version, or null when the project already had every file the template could add. */
	snapshotId: string | null;
	version: number | null;
	added: number;
	skipped: Array<{ path: string; reason: TemplateSkipReason }>;
};

/**
 * Add the organization template's published files to a project as a new
 * version of the project's coding instructions.
 *
 * The new version is an ordinary upload as far as everything after this is
 * concerned: its rows are staged, the bytes are copied inside storage into
 * the exact staging keys the browser would have uploaded to, and the same
 * verify → scan → publish workflow decides it. A copied row is NOT inherited
 * (`inheritedFromFileId` stays null), so the gate re-hashes and re-scans every
 * copied file under this project's rules; nothing the template's own checks
 * decided is carried over. It publishes itself when it passes, never before
 * its scan.
 *
 * The project wins every clash: only paths the project does not have are
 * added (`planTemplateAdditions`), and the template's root `.fabricignore` is
 * never copied, so the project's own rules decide what is excluded. With
 * nothing published yet, the version is the project's first, admitted under
 * its live ignore settings; otherwise it derives from the published version,
 * whose files are inherited unchanged.
 *
 * Nothing updates later. A template change reaches the project only when
 * someone runs this again.
 */
export async function applyOrganizationInstructionTemplate(input: {
	projectId: string;
	userId: string;
	audit: AuditRequestContext;
}): Promise<ApplyTemplateResult> {
	const { projectId, userId } = input;
	const organizationId = await requireHostingOrganizationId(
		projectId,
		userId,
	);
	const settings = await getProjectInstructionSettings(
		projectId,
		organizationId,
	);
	if (settings.migration) {
		throw await migrationOpenError(settings.migration, {
			projectId,
			organizationId,
		});
	}
	if (settings.sourceOfTruth === "REPOSITORY") {
		throw new ORPCError("PRECONDITION_FAILED", {
			message:
				"This project's coding instructions come from its repository. Change the files there and sync the project.",
		});
	}

	const template = await readOrganizationTemplate({
		organizationId,
		projectId,
	});
	switch (template.state) {
		case "not_set":
			throw new ORPCError("NOT_FOUND", {
				message:
					"Your organization has no template for coding instructions.",
				data: { reason: "NO_TEMPLATE" },
			});
		case "is_template":
			throw new ORPCError("BAD_REQUEST", {
				message:
					"This project is the organization template. Upload or edit its files directly.",
				data: { reason: "IS_TEMPLATE" },
			});
		case "nothing_published":
			throw new ORPCError("NOT_FOUND", {
				message:
					"The organization template has no published coding instructions yet.",
				data: { reason: "TEMPLATE_NOT_PUBLISHED" },
			});
		case "available":
			break;
		default: {
			const unhandled: never = template;
			throw new Error(`Unhandled template state: ${String(unhandled)}`);
		}
	}
	const templateSnapshot = template.snapshot;
	const sources = await listTemplateFiles({
		organizationId,
		templateProjectId: template.templateProjectId,
		snapshotId: templateSnapshot.id,
	});

	// `getPublishedInstructionSnapshot` follows the pointer on the Project row
	// and is unscoped, so the tenant-scoped read proves the base is this
	// organization's.
	const publishedPointer = await getPublishedInstructionSnapshot(projectId);
	const base = publishedPointer
		? await getInstructionSnapshot(
				publishedPointer.id,
				projectId,
				organizationId,
			)
		: null;
	if (publishedPointer && !base) {
		throw new ORPCError("NOT_FOUND", {
			message: "That version is not available to edit",
		});
	}
	// The base's OWN frozen rules for a derived version, as
	// `validateInstructionChanges` reads them; the project's live rules for a
	// first version, as `begin` resolves them without a `.fabricignore`.
	const ignore = base
		? (readFrozenIgnoreGlobs(base.settingsFrozen) ?? {
				globs: [],
				layer: "default" as const,
			})
		: resolveIgnoreGlobs({
				fabricIgnoreText: null,
				projectGlobs: settings.ignoreGlobs,
			});
	const plan = planTemplateAdditions({
		projectId,
		files: sources,
		existingPaths: base
			? (await listInstructionFiles(base.id, organizationId)).map(
					(f) => f.path,
				)
			: [],
		ignore,
	});
	const skipped = plan.skipped.map(({ path, reason }) => ({ path, reason }));
	if (plan.additions.length === 0) {
		return { snapshotId: null, version: null, added: 0, skipped };
	}

	let created: {
		id: string;
		version: number;
		stagedFileIds: string[];
		inheritedCount: number;
	};
	if (base) {
		const derived = await createDerivedInstructionSnapshot({
			projectId,
			organizationId,
			userId,
			baseSnapshotId: base.id,
			publishOnReady: true,
			proposal: false,
			changes: plan.additions.map((a) => a.change),
			limits: {
				maxFiles: SNAPSHOT_LIMITS.maxFiles,
				maxTotalBytes: SNAPSHOT_LIMITS.maxTotalBytes,
			},
			baseKeyPrefix: snapshotPrefix(projectId, base.id),
		}).catch(versionContentionAsConflict);
		if (!derived.ok) {
			// Only a proposal is ever matched as a duplicate; this is not one.
			if (derived.reason === "duplicate_proposal") {
				throw new ORPCError("CONFLICT", {
					message:
						"An identical version is already being prepared. Try again in a moment.",
				});
			}
			throw derivedSnapshotRefusal(derived.reason, derived.detail);
		}
		created = {
			id: derived.id,
			version: derived.version,
			stagedFileIds: derived.staged.map((f) => f.id),
			inheritedCount: derived.inheritedCount,
		};
	} else {
		const totalBytes = plan.additions.reduce(
			(sum, a) => sum + a.change.size,
			0,
		);
		if (
			plan.additions.length > SNAPSHOT_LIMITS.maxFiles ||
			totalBytes > SNAPSHOT_LIMITS.maxTotalBytes
		) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"The organization template is larger than one version of coding instructions can hold.",
			});
		}
		const excluded = plan.skipped.flatMap((s) =>
			s.reason === "excluded"
				? [{ path: s.path, rule: s.rule ?? "" }]
				: [],
		);
		const first = await createInstructionSnapshot({
			projectId,
			organizationId,
			userId,
			source: "UPLOAD",
			settingsFrozen: {
				ignoreGlobs: ignore.globs,
				layer: ignore.layer,
				limits: SNAPSHOT_LIMITS,
			},
			publishOnReady: true,
			excludedCount: excluded.length,
			excludedPaths: mergeExcludedPaths(excluded),
			files: plan.additions.map(({ change }) => ({
				path: change.path,
				size: change.size,
				sha256: change.sha256,
				mimeType: change.mimeType,
				isText: change.isText,
				kind: change.kind,
				storageKey: change.storageKey,
			})),
		}).catch(versionContentionAsConflict);
		created = {
			id: first.id,
			version: first.version,
			stagedFileIds: first.files.map((f) => f.id),
			inheritedCount: 0,
		};
	}

	// Keyed by the STORED path, which is what the staged rows carry.
	const sourceKeyByPath = new Map(
		plan.additions.map((a) => [a.change.path, a.source.storageKey]),
	);
	const storage = getStorageProvider();
	await stageAndFinalizeInstructionSnapshot({
		snapshotId: created.id,
		projectId,
		organizationId,
		userId,
		stagedFileIds: created.stagedFileIds,
		compensationSource: "template_copy_compensation",
		concurrency: TEMPLATE_COPY_CONCURRENCY,
		beforeStaging: async () => {
			// The upload vocabulary, as `derive` and inline submission record
			// it, with the template's version as the provenance. Counts and
			// ids only: a path is user content.
			recordAuditFromRequest(input.audit, {
				action: "project.instructions.upload_started",
				category: "project",
				organizationId,
				projectId,
				resource: {
					type: "project_instruction_snapshot",
					id: created.id,
					name: `v${created.version}`,
				},
				metadata: {
					mode: "template",
					templateSnapshotId: templateSnapshot.id,
					templateVersion: templateSnapshot.version,
					keptCount: plan.additions.length,
					skippedCount: plan.skipped.length,
					inheritedCount: created.inheritedCount,
					...(base
						? { baseSnapshotId: base.id, baseVersion: base.version }
						: {}),
				},
			});
		},
		writeObject: async (row, key) => {
			const sourceKey = sourceKeyByPath.get(row.path);
			if (!sourceKey) {
				// Unreachable: every staged row came from a template file.
				throw new ORPCError("INTERNAL_SERVER_ERROR", {
					message: `No template file was found for ${row.path}`,
				});
			}
			try {
				await storage.copyFile(sourceKey, key, {
					bucket: SKILLS_BUCKET,
				});
			} catch (error) {
				// Told apart by a HEAD of the source, as the inherited-file
				// copy does: gone means the template version was removed
				// while this ran, anything else is the storage failing.
				const head = await storage.getFileMetadata(sourceKey, {
					bucket: SKILLS_BUCKET,
				});
				if (head === null) {
					throw new ORPCError("CONFLICT", {
						message:
							"The organization template changed while its files were being copied. Try again.",
						data: { reason: "TEMPLATE_CHANGED" },
					});
				}
				throw error;
			}
		},
	});

	return {
		snapshotId: created.id,
		version: created.version,
		added: plan.additions.length,
		skipped,
	};
}

/**
 * AUTHORIZATION: tenantProtectedProcedure + projectNotFoundUnlessVisible + requireProjectPermission(INSTRUCTION_CREATE).
 *
 * "Start from the organization template" / "Add files from the organization
 * template" on the Coding Instructions tab. INSTRUCTION_CREATE on THIS
 * project, the permission a folder upload needs; access to the template
 * project is not required, because the organization's designation is what
 * makes its files available to the organization's projects. Not offered on
 * v1, the CLI or MCP.
 */
export const applyTemplateProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.INSTRUCTION_CREATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/instructions/apply-template",
		tags: ["Projects", "Instructions"],
		summary: "Add the organization template's coding instructions",
	})
	.input(
		z.object({
			projectId: z.string(),
		}),
	)
	.handler(({ input, context }) =>
		applyOrganizationInstructionTemplate({
			projectId: input.projectId,
			userId: context.user.id,
			audit: context,
		}),
	);
