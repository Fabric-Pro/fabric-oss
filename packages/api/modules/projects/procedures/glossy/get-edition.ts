import { config } from "@repo/config";
import {
	canEditProject,
	computeDocumentContentHash,
	db,
	type GlossyBuildSummary,
	type GlossyEditionView,
	getBrandKitForProject,
	getGlossyEdition,
	getOrganizationBrandColor,
	getRecipientBrand,
} from "@repo/database";
import { logger } from "@repo/logs";
import { getStorageProvider } from "@repo/storage";
import {
	type EditionAnchor,
	type EditionContent,
	editionContentSchema,
} from "@repo/utils/glossy/edition-content";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { isGlossyHolderGone } from "../../lib/dispatch-glossy-build";
import {
	GLOSSY_INELIGIBLE_REASONS,
	type GlossyUserRef,
	glossyIneligibility,
	glossyLastOptionsSchema,
	glossyUserRefSchema,
	loadGlossyDocument,
	loadGlossyUserRefs,
	readGlossyEditionContent,
	readGlossyLastOptions,
} from "../../lib/glossy-access";
import {
	presentRecipientBrand,
	recipientBrandOutputSchema,
} from "../../lib/recipient-brand";
import { requireGlossyEnabled } from "../../lib/glossy-feature";

/**
 * Signed reads of the document's own images and both logos, for one page
 * session: the page refreshes them only after 45 minutes
 * (`SIGNED_URL_REFRESH_MS`), so every read it holds must outlast that.
 */
const SIGNED_READ_TTL_SECONDS = 60 * 60;

/** An edition never carries more uploaded images than this worth signing. */
const MAX_SIGNED_IMAGES = 100;

const buildStateSchema = z.discriminatedUnion("status", [
	z.object({ status: z.literal("idle") }),
	z.object({
		status: z.literal("building"),
		/** `preparing`, `detecting`, `rewriting`, `visualizing`, or `finalizing`. */
		step: z.string().nullable(),
		sectionsDone: z.number().int(),
		sectionsTotal: z.number().int().nullable(),
		startedAt: z.date(),
		startedBy: glossyUserRefSchema.nullable(),
	}),
	z.object({
		status: z.literal("failed"),
		/** A `GlossyBuildErrorCode`; the page maps it to translated copy. */
		errorCode: z.string(),
		/** The fixed message persisted with the code; null for a stuck run. */
		errorMessage: z.string().nullable(),
		/**
		 * The run stopped without recording a failure — it hit its execution
		 * timeout — and Temporal confirms it is gone. The next build takes
		 * its claim over.
		 */
		stuck: z.boolean(),
		startedAt: z.date(),
		finishedAt: z.date().nullable(),
		startedBy: glossyUserRefSchema.nullable(),
	}),
]);

type GlossyBuildState = z.infer<typeof buildStateSchema>;

const outputSchema = z.object({
	document: z.object({
		title: z.string(),
		type: z.string(),
		version: z.number().int(),
	}),
	eligibility: z.object({
		eligible: z.boolean(),
		reason: z.enum(GLOSSY_INELIGIBLE_REASONS).nullable(),
	}),
	/** Whether the caller may build, rebuild, and review (R5). */
	canEdit: z.boolean(),
	edition: z
		.object({
			/** The published edition; null before the first build finishes. */
			content: editionContentSchema.nullable(),
			contentRevision: z.number().int(),
			updatedAt: z.date(),
			/** The source the published content was built from (R7, R43). */
			builtFrom: z
				.object({
					title: z.string(),
					version: z.number().int(),
					builtAt: z.date().nullable(),
				})
				.nullable(),
			/** The source's content or title changed since (R7). */
			outOfDate: z.boolean(),
			/** A rebuild failed and the previous edition is still shown (KTD5). */
			lastRebuildFailed: z.boolean(),
			/**
			 * Review decisions of the visuals in `content`. An acceptance is
			 * listed only while it approved the visual's current spec; a
			 * visual with none is pending (R28).
			 */
			decisions: z.array(
				z.object({
					visualKey: z.string(),
					decision: z.enum(["ACCEPTED", "DISCARDED"]),
					decidedAt: z.date(),
				}),
			),
			lastOptions: glossyLastOptionsSchema.nullable(),
		})
		.nullable(),
	build: buildStateSchema,
	/** Applied by the browser at render time, so a brand change never needs a rebuild. */
	brand: z.object({
		preparer: z.object({
			name: z.string(),
			/** A short-lived signed read; null without an uploaded logo. */
			logoUrl: z.string().nullable(),
			/** The organization's named brand color. */
			brandColorName: z.string().nullable(),
			accentColors: z.array(z.string()),
			guidance: z.string().nullable(),
		}),
		recipient: recipientBrandOutputSchema.nullable(),
		/** What a recipient brand confirmation sends back (KTD23). */
		recipientVersion: z.number().int(),
	}),
	/** Signed reads of the document's own uploaded images, by S3 key (KTD16). */
	imageUrls: z.record(z.string(), z.string()),
});

/**
 * The Glossy edition of a document (Fizzy #2589, R4, R5, R7, R9, KTD5, KTD6,
 * KTD10, KTD16, KTD19, AE7).
 *
 * Any project member with read access, invited guests included, reads the
 * published edition, its review decisions, the build state, both brands, and
 * signed reads of the document's own images. Nothing here writes; a build
 * starts only from `projects.glossy.build`.
 *
 * - The edition read selects explicit columns and never loads a snapshot.
 * - Out of date compares the live content's hash and title with the
 *   published build's source, so a revert that leaves `version` unchanged
 *   still counts (KTD6).
 * - A running build whose heartbeat is stale reads as failed only once
 *   Temporal confirms its run is gone; until then it is building.
 * - The preparer Brand kit is read through `getBrandKitForProject`, the one
 *   path a guest of the project, who is not a member of its organization,
 *   is allowed to use.
 * - Image anchors come from stored edition content, so each key is checked
 *   again to sit under `document-media/{projectId}/` before it is signed.
 *
 * AUTHORIZATION: `requireGlossyEnabled` first (gate off → NOT_FOUND for every
 * caller), then `requireProjectPermission(DOCUMENT_READ)`, then the shared
 * Glossy gate (rollout flag, trashed project, document in project,
 * `hasProjectAccess`).
 */
export const getGlossyEditionProcedure = tenantProtectedProcedure
	.use(requireGlossyEnabled())
	.use(requireProjectPermission(Permissions.DOCUMENT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/documents/{documentId}/glossy",
		tags: ["Projects", "Glossy"],
		summary: "Get the Glossy edition",
		description:
			"The document's Glossy edition, its review decisions and build state, and the brands it renders with.",
	})
	.input(
		z.object({
			projectId: z.string(),
			documentId: z.string(),
		}),
	)
	.output(outputSchema)
	.handler(async ({ input, context }) => {
		const { document, organizationId } = await loadGlossyDocument({
			projectId: input.projectId,
			documentId: input.documentId,
			userId: context.user.id,
			write: false,
		});

		const now = new Date();
		const [edition, canEdit, preparer, recipientBrand] = await Promise.all([
			getGlossyEdition({
				documentId: input.documentId,
				projectId: input.projectId,
			}),
			canEditProject(input.projectId, context.user.id),
			loadPreparer(input.projectId, organizationId),
			getRecipientBrand(input.projectId),
		]);

		const content = parseContent(edition);
		const [build, recipient, imageUrls] = await Promise.all([
			readBuildState(edition, now),
			recipientBrand
				? presentRecipientBrand(recipientBrand, {
						expiresIn: SIGNED_READ_TTL_SECONDS,
					})
				: null,
			signOwnImages(content, input.projectId, input.documentId),
		]);

		const ineligible = glossyIneligibility(document);
		return {
			document: {
				title: document.title,
				type: document.type,
				version: document.version,
			},
			eligibility: { eligible: ineligible === null, reason: ineligible },
			canEdit,
			edition: edition
				? {
						content,
						contentRevision: edition.contentRevision,
						updatedAt: edition.updatedAt,
						builtFrom: edition.publishedBuild
							? {
									title: edition.publishedBuild.sourceTitle,
									version:
										edition.publishedBuild.sourceVersion,
									builtAt: edition.publishedBuild.finishedAt,
								}
							: null,
						outOfDate: isOutOfDate(
							edition.publishedBuild,
							document,
						),
						lastRebuildFailed:
							content !== null && build.status === "failed",
						decisions: reviewDecisions(content, edition.decisions),
						lastOptions: readGlossyLastOptions(edition.lastOptions),
					}
				: null,
			build,
			brand: {
				preparer,
				recipient,
				recipientVersion: recipientBrand?.version ?? 0,
			},
			imageUrls,
		};
	});

/** The stored content, or null when there is none or this code cannot read it. */
function parseContent(
	edition: GlossyEditionView | null,
): EditionContent | null {
	if (!edition?.content) {
		return null;
	}
	const content = readGlossyEditionContent(edition.content);
	if (!content) {
		logger.warn("[GlossyEdition] Stored edition content does not parse", {
			documentId: edition.documentId,
		});
	}
	return content;
}

/** R7, KTD6: the live content's hash or the title differs from the published source. */
function isOutOfDate(
	published: GlossyBuildSummary | null,
	document: { content: string; title: string },
): boolean {
	if (!published) {
		return false;
	}
	return (
		computeDocumentContentHash(document.content) !==
			published.sourceContentHash ||
		document.title !== published.sourceTitle
	);
}

/**
 * Decisions of the visuals the content holds. DISCARDED applies by visual
 * key alone; ACCEPTED only while its spec hash is the visual's current one,
 * so a regenerated visual reads as pending again (KTD10).
 */
function reviewDecisions(
	content: EditionContent | null,
	decisions: GlossyEditionView["decisions"],
): Array<{
	visualKey: string;
	decision: "ACCEPTED" | "DISCARDED";
	decidedAt: Date;
}> {
	if (!content) {
		return [];
	}
	return decisions.flatMap((decision) => {
		const visual = Object.hasOwn(content.visuals, decision.visualKey)
			? content.visuals[decision.visualKey]
			: undefined;
		if (!visual) {
			return [];
		}
		if (
			decision.decision === "ACCEPTED" &&
			decision.specHash !== visual.specHash
		) {
			return [];
		}
		return [
			{
				visualKey: decision.visualKey,
				decision: decision.decision,
				decidedAt: decision.updatedAt,
			},
		];
	});
}

async function readBuildState(
	edition: GlossyEditionView | null,
	now: Date,
): Promise<GlossyBuildState> {
	if (!edition) {
		return { status: "idle" };
	}
	const current = edition.currentBuild;
	const latest = edition.latestAttempt;
	const starters = await loadGlossyUserRefs([
		current?.startedById,
		latest?.startedById,
	]);
	const starter = (id: string | null): GlossyUserRef | null =>
		id ? (starters.get(id) ?? null) : null;

	if (current) {
		if (await isGlossyHolderGone(current, now)) {
			return {
				status: "failed",
				errorCode: "BUILD_FAILED",
				errorMessage: null,
				stuck: true,
				startedAt: current.startedAt,
				finishedAt: null,
				startedBy: starter(current.startedById),
			};
		}
		return {
			status: "building",
			step: current.progressStep,
			sectionsDone: current.sectionsDone,
			sectionsTotal: current.sectionsTotal,
			startedAt: current.startedAt,
			startedBy: starter(current.startedById),
		};
	}
	if (latest?.status === "FAILED") {
		return {
			status: "failed",
			errorCode: latest.errorCode ?? "BUILD_FAILED",
			errorMessage: latest.errorMessage,
			stuck: false,
			startedAt: latest.startedAt,
			finishedAt: latest.finishedAt,
			startedBy: starter(latest.startedById),
		};
	}
	return { status: "idle" };
}

/**
 * The preparer as the cover and palette use it (R31, R35). The Brand kit
 * comes through `getBrandKitForProject`; the organization row and its named
 * color are read by the id the gate resolved from the project.
 */
async function loadPreparer(projectId: string, organizationId: string) {
	const [organization, brandColorName, brandKit] = await Promise.all([
		db.organization.findUnique({
			where: { id: organizationId },
			select: { name: true, logo: true },
		}),
		getOrganizationBrandColor(organizationId),
		getBrandKitForProject(projectId),
	]);
	return {
		name: organization?.name ?? "",
		logoUrl: await signOrganizationLogo(organization?.logo ?? null),
		brandColorName,
		accentColors: brandKit?.accentColors ?? [],
		guidance: brandKit?.guidance ?? null,
	};
}

/**
 * A signed read of an uploaded organization logo. A logo that is a URL of
 * its own is never passed on: the Glossy render fetches no remote image
 * (KTD16), so without an upload the cover shows the name alone.
 */
async function signOrganizationLogo(
	logo: string | null,
): Promise<string | null> {
	if (!logo || /^[a-z][a-z0-9+.-]*:/i.test(logo) || logo.includes("..")) {
		return null;
	}
	try {
		return await getStorageProvider().getSignedUrl(logo, {
			bucket: config.storage.bucketNames.avatars,
			expiresIn: SIGNED_READ_TTL_SECONDS,
		});
	} catch {
		return null;
	}
}

/**
 * Signed reads for the image anchors of stored content. The key comes from
 * the database, not from this request, and cleanup accepted it under a
 * project-wide rule when the build ran — so it is checked again here, against
 * the document the caller was authorized for, before anything is signed:
 * the same `document-media/{projectId}/{documentId}/` scope the regular
 * export's media resolution signs.
 */
async function signOwnImages(
	content: EditionContent | null,
	projectId: string,
	documentId: string,
): Promise<Record<string, string>> {
	if (!content) {
		return {};
	}
	const prefix = `document-media/${projectId}/${documentId}/`;
	const keys = new Set<string>();
	const collect = (anchors: readonly EditionAnchor[]) => {
		for (const anchor of anchors) {
			if (
				anchor.ref.type === "image" &&
				anchor.ref.s3Key.startsWith(prefix) &&
				!anchor.ref.s3Key.includes("..")
			) {
				keys.add(anchor.ref.s3Key);
			}
		}
	};
	for (const section of content.sections) {
		collect(section.anchors);
	}
	for (const section of content.appendix.additionalMaterial) {
		collect(section.anchors);
	}

	const storage = getStorageProvider();
	const bucket = config.storage.bucketNames.projectContexts;
	const results = await Promise.allSettled(
		[...keys].slice(0, MAX_SIGNED_IMAGES).map(async (key) => ({
			key,
			url: await storage.getSignedUrl(key, {
				bucket,
				expiresIn: SIGNED_READ_TTL_SECONDS,
			}),
		})),
	);
	const urls: Record<string, string> = {};
	for (const result of results) {
		// A missing object is left out; the render counts it as omitted.
		if (result.status === "fulfilled") {
			urls[result.value.key] = result.value.url;
		}
	}
	return urls;
}
