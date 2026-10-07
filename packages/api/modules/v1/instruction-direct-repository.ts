import { repositoryIdentity } from "@repo/database";
import {
	type DirectRepositoryAvailability,
	resolveDirectRepositoryState,
} from "../projects/procedures/instructions/repository/direct-state";

export {
	getDirectRepositoryFileForApi,
	listDirectRepositoryFilesForApi,
} from "../projects/procedures/instructions/repository/direct-query";
export { directRepositoryAvailability } from "../projects/procedures/instructions/repository/direct-state";

export type DirectRepositoryState =
	| {
			availability: "READY";
			readState: "DIRECT";
			generation: number;
			currentCommitSha: string;
			ref: string;
			rootPath: string;
			provider: "GITHUB" | "GITLAB" | "AZURE_DEVOPS";
			gitGateway: { version: "v1" };
			repository: {
				provider: "GITHUB" | "GITLAB" | "AZURE_DEVOPS";
				host: string;
				path: string;
				cloneUrl: string | null;
			};
	  }
	| {
			availability: Exclude<DirectRepositoryAvailability, "READY">;
			readState: "DIRECT";
	  };

export async function getDirectRepositoryState(input: {
	projectId: string;
	userId: string;
	signal?: AbortSignal;
}): Promise<DirectRepositoryState> {
	const state = await resolveDirectRepositoryState(input);
	if (state.availability !== "READY") {
		return state;
	}
	const identity = repositoryIdentity({
		provider: state.source.repository.provider,
		repositoryUrl: state.source.repository.repositoryUrl,
		repositoryOwner: state.source.repository.owner,
		repositoryName: state.source.repository.repo,
	});
	if (identity === null) {
		return { availability: "DISCONNECTED", readState: "DIRECT" };
	}
	return {
		availability: "READY",
		readState: "DIRECT",
		generation: state.pin.generation,
		currentCommitSha: state.pin.commitSha,
		ref: state.source.ref,
		rootPath: state.source.rootPath,
		provider: state.source.repository.provider,
		gitGateway: { version: "v1" },
		repository: { provider: state.source.repository.provider, ...identity },
	};
}
