/**
 * Clusters of open bug reports that describe the same problem.
 *
 * Reuses the duplicate detector rather than a second similarity model, but
 * never runs it inline: its LLM verifier over a project's open bugs can take
 * longer than the whole scan may, and a scan that times out files nothing.
 * Clusters are the connected components of the DUPLICATE edges the detector
 * has already confirmed between open bugs, and each scan hands the detector a
 * fresh durable run (`detectDuplicatesWorkflow`, with its own retries and
 * timeouts) so pairs it has not judged yet are clustered on the next scan. A
 * by-product is that those pairs also surface on the Roadmap as duplicate
 * suggestions, exactly as after any AI write.
 */
import {
	listDuplicateEdgesAmong,
	listOpenBugStoriesForClustering,
} from "@repo/database";
import { triggerDuplicateDetection } from "../../lib/trigger-duplicate-detection";
import { clusterByEdges } from "./fingerprint";

export type OpenBugStory = { id: string; identifier: string; title: string };

export async function findOpenBugClusters(input: {
	projectId: string;
	organizationId: string | null;
	userId: string;
	minSize: number;
	/** Minimum confidence of a duplicate edge that joins two bugs. */
	minConfidence: number;
	/** Stories that are themselves consolidations filed by this scan. */
	excludeStoryIds: Set<string>;
}): Promise<OpenBugStory[][]> {
	const stories = (
		await listOpenBugStoriesForClustering(input.projectId)
	).filter((story) => !input.excludeStoryIds.has(story.id));
	if (stories.length < Math.max(2, input.minSize)) {
		return [];
	}
	const ids = stories.map((story) => story.id);

	// Never throws: a refresh that cannot be enqueued only delays clustering.
	await triggerDuplicateDetection({
		projectId: input.projectId,
		userId: input.userId,
		organizationId: input.organizationId,
		targetStoryIds: ids,
	});

	const edges = await listDuplicateEdgesAmong(
		input.projectId,
		ids,
		input.minConfidence,
	);
	const byId = new Map(stories.map((story) => [story.id, story]));
	return clusterByEdges(ids, edges, input.minSize).map((members) =>
		members.flatMap((id) => {
			const story = byId.get(id);
			return story ? [story] : [];
		}),
	);
}
