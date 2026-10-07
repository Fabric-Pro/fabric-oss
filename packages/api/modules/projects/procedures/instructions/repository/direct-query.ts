import { ORPCError } from "@orpc/client";
import { commitShaSchema } from "./commit-sha";
import {
	listDirectRepositoryFiles,
	readDirectRepositoryFile,
} from "./direct-read";
import {
	assertDirectRepositoryPin,
	assertDirectRepositorySourceCurrent,
	loadDirectRepositorySource,
	resolveDirectRepositoryHead,
} from "./direct-source";
import { settle, unsettle } from "./settle";

type DirectReadInput = {
	projectId: string;
	userId: string;
	signal?: AbortSignal;
	generation?: number;
	commitSha?: string;
};

type Source = Awaited<ReturnType<typeof loadDirectRepositorySource>>;

/**
 * The pin to read at and, for a client-supplied pin, the check that it names
 * a commit on the configured branch. The check is returned rather than
 * awaited so the read can run beside it; a read is only released once it has
 * passed, and a failed check is the error, ahead of any read failure.
 */
async function resolvePin(
	source: Source,
	input: DirectReadInput,
): Promise<{
	pin: { generation: number; commitSha: string };
	verified: Promise<void>;
}> {
	if (input.generation === undefined && input.commitSha === undefined) {
		return {
			pin: await resolveDirectRepositoryHead(source),
			verified: Promise.resolve(),
		};
	}
	if (
		input.generation === undefined ||
		input.commitSha === undefined ||
		!commitShaSchema.safeParse(input.commitSha).success
	) {
		throw new ORPCError("BAD_REQUEST", {
			message:
				"generation and a full lowercase commitSha must be provided together",
		});
	}
	const pin = { generation: input.generation, commitSha: input.commitSha };
	return { pin, verified: assertDirectRepositoryPin(source, pin) };
}

/** Run `read` beside the pin check; the check's failure comes first. */
async function readPinned<T>(
	source: Source,
	input: DirectReadInput,
	read: (pin: { generation: number; commitSha: string }) => Promise<T>,
): Promise<{ pin: { generation: number; commitSha: string }; value: T }> {
	const { pin, verified } = await resolvePin(source, input);
	const [checked, value] = await Promise.all([
		settle(verified),
		settle(read(pin)),
	]);
	unsettle(checked);
	return { pin, value: unsettle(value) };
}

export async function listDirectRepositoryFilesForApi(input: DirectReadInput) {
	const source = await loadDirectRepositorySource(input);
	try {
		const { pin, value } = await readPinned(source, input, (pin) =>
			listDirectRepositoryFiles({ source, pin }),
		);
		return { ...pin, ...value };
	} finally {
		await assertDirectRepositorySourceCurrent({ ...input, source });
	}
}

export async function getDirectRepositoryFileForApi(
	input: DirectReadInput & {
		generation: number;
		commitSha: string;
		path: string;
	},
) {
	const source = await loadDirectRepositorySource(input);
	try {
		const { pin, value: read } = await readPinned(source, input, (pin) =>
			readDirectRepositoryFile({ source, pin, path: input.path }),
		);
		return { ...pin, read };
	} finally {
		await assertDirectRepositorySourceCurrent({ ...input, source });
	}
}
