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
import { inOrder } from "./settle";

type DirectReadInput = {
	projectId: string;
	userId: string;
	signal?: AbortSignal;
	generation?: number;
	commitSha?: string;
};

type Source = Awaited<ReturnType<typeof loadDirectRepositorySource>>;
type DirectPin = { generation: number; commitSha: string };

/**
 * The pin to read at and, for a client-supplied pin, the check that it names
 * a commit on the configured branch. The check is returned rather than
 * awaited so the read can run beside it; a read is only released once it has
 * passed, and a failed check is the error, ahead of any read failure.
 */
async function resolvePin(
	source: Source,
	input: DirectReadInput,
): Promise<{ pin: DirectPin; verified: Promise<void> }> {
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

/**
 * One direct read, authorized end to end: the source is loaded (the caller's
 * visibility and permission), the pin resolved, `read` run beside the pin's
 * check (whose failure comes first), and the caller's permission and the
 * repository configuration checked again once the read is done, whatever it
 * answered.
 */
export async function withDirectRead<T>(
	input: DirectReadInput,
	read: (context: { source: Source; pin: DirectPin }) => Promise<T>,
): Promise<{ pin: DirectPin; value: T }> {
	const source = await loadDirectRepositorySource(input);
	try {
		const { pin, verified } = await resolvePin(source, input);
		const [, value] = await inOrder(verified, read({ source, pin }));
		return { pin, value };
	} finally {
		await assertDirectRepositorySourceCurrent({ ...input, source });
	}
}

export async function listDirectRepositoryFilesForApi(input: DirectReadInput) {
	const { pin, value } = await withDirectRead(input, (context) =>
		listDirectRepositoryFiles(context),
	);
	return { ...pin, ...value };
}

export async function getDirectRepositoryFileForApi(
	input: DirectReadInput & {
		generation: number;
		commitSha: string;
		path: string;
	},
) {
	const { pin, value: read } = await withDirectRead(input, (context) =>
		readDirectRepositoryFile({ ...context, path: input.path }),
	);
	return { ...pin, read };
}
