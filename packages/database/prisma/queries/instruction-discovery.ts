import { db } from "../client";
import { migrationOfSettings } from "./instruction-migration-pointer";
import {
	type PublishedInstructionRepositoryConfig,
	repositoryIdentity,
} from "./instructions";

export type InstructionDiscoverySummary =
	| {
			source: "repository";
			repository: Omit<
				PublishedInstructionRepositoryConfig,
				"sync"
			> | null;
	  }
	| {
			version: number;
			fileCount: number;
			digest: string;
			publishedAt: Date | null;
	  };

/** Metadata only, for already-visible projects. Callers must check instruction read permission. */
export async function getInstructionSummariesForProjects(
	projectIds: string[],
): Promise<Map<string, InstructionDiscoverySummary | null>> {
	const summaries = new Map<string, InstructionDiscoverySummary | null>();
	if (projectIds.length === 0) {
		return summaries;
	}
	const projects = await db.project.findMany({
		where: { id: { in: projectIds } },
		select: {
			id: true,
			organizationId: true,
			instructionSettings: true,
			instructionRepositorySync: {
				select: {
					organizationId: true,
					ref: true,
					rootPath: true,
					generation: true,
					repositoryIntegration: {
						select: {
							projectId: true,
							provider: true,
							repositoryUrl: true,
							repositoryOwner: true,
							repositoryName: true,
						},
					},
				},
			},
			publishedInstructionSnapshot: {
				select: {
					organizationId: true,
					status: true,
					version: true,
					fileCount: true,
					digest: true,
					publishedAt: true,
				},
			},
		},
	});
	for (const project of projects) {
		const settings = project.instructionSettings;
		if (
			settings !== null &&
			typeof settings === "object" &&
			"sourceOfTruth" in settings &&
			settings.sourceOfTruth === "REPOSITORY" &&
			migrationOfSettings(settings) === null
		) {
			const sync = project.instructionRepositorySync;
			const identity =
				sync &&
				sync.organizationId === project.organizationId &&
				sync.repositoryIntegration.projectId === project.id
					? repositoryIdentity(sync.repositoryIntegration)
					: null;
			summaries.set(project.id, {
				source: "repository",
				repository:
					identity && sync
						? {
								provider: sync.repositoryIntegration.provider,
								...identity,
								ref: sync.ref,
								rootPath: sync.rootPath,
								generation: sync.generation,
							}
						: null,
			});
			continue;
		}
		const snapshot = project.publishedInstructionSnapshot;
		summaries.set(
			project.id,
			snapshot &&
				snapshot.status === "READY" &&
				snapshot.digest !== null &&
				snapshot.organizationId === project.organizationId
				? {
						version: snapshot.version,
						fileCount: snapshot.fileCount,
						digest: snapshot.digest,
						publishedAt: snapshot.publishedAt,
					}
				: null,
		);
	}
	return summaries;
}
