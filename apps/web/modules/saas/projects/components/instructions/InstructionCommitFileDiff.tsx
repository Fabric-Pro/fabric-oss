"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Skeleton } from "@ui/components/skeleton";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { InstructionDiffBody } from "./InstructionDiffBody";

/**
 * Kinds whose body is not drawn until somebody asks for it: a script and a
 * settings file are what RUN rather than being read as prose.
 */
const GUARDED_KINDS = new Set(["SCRIPT", "SETTINGS"]);

/** `repositorySync.readCommitFile`'s answer: the text, or the reason there is none. */
type CommitFile =
	| { state: "found"; content: string }
	| { state: "absent" | "tooLarge" | "binary" }
	| { state: "withheld"; reason: "refused" | "secret" };

/**
 * The one plain line for a side that cannot be shown, or null when both sides
 * can (a file that did not exist on a side is an empty side, not a problem).
 * Withheld outranks the rest: what Fabric will not show is the thing to say.
 */
function unavailableLine(
	sides: CommitFile[],
):
	| "withheldRefused"
	| "withheldSecret"
	| "tooLargeCommit"
	| "binaryChangedCommit"
	| null {
	const withheld = sides.find((side) => side.state === "withheld");
	if (withheld?.state === "withheld") {
		return withheld.reason === "refused"
			? "withheldRefused"
			: "withheldSecret";
	}
	if (sides.some((side) => side.state === "tooLarge")) {
		return "tooLargeCommit";
	}
	if (sides.some((side) => side.state === "binary")) {
		return "binaryChangedCommit";
	}
	return null;
}

function textOf(side: CommitFile): string {
	return side.state === "found" ? side.content : "";
}

/**
 * One changed file's line diff between two commits of the synced branch,
 * fetched only once its row is expanded: the commit-side counterpart of
 * `InstructionFileDiff`, reading each side through `readCommitFile`.
 *
 * Fabric will not show a file it withheld (its commit was refused by the secret
 * scan, or the file's own text holds a secret), one that is not text, or one
 * past the inline cap, and says so in one plain line instead of a diff; it
 * never names a rule or a line. A script or settings file waits for a click, as
 * it does in a snapshot compare.
 */
export function InstructionCommitFileDiff({
	projectId,
	fromSha,
	toSha,
	path,
	kind,
	isText,
}: {
	projectId: string;
	fromSha: string;
	toSha: string;
	path: string;
	kind: string;
	/** False when either side is not text: there is no line diff to draw. */
	isText: boolean;
}) {
	const t = useTranslations("projects.codingInstructions.compare");
	const [revealed, setRevealed] = useState(false);
	const guarded = GUARDED_KINDS.has(kind);
	const kindLabels = useTranslations(
		"projects.codingInstructions.fileView",
	).raw("kindLabels") as Record<string, string>;
	const shouldFetch = isText && (!guarded || revealed);
	const fromQuery = useQuery({
		...orpc.projects.instructions.repositorySync.readCommitFile.queryOptions(
			{
				input: { projectId, sha: fromSha, path },
			},
		),
		enabled: shouldFetch,
		retry: false,
	});
	const toQuery = useQuery({
		...orpc.projects.instructions.repositorySync.readCommitFile.queryOptions(
			{
				input: { projectId, sha: toSha, path },
			},
		),
		enabled: shouldFetch,
		retry: false,
	});

	if (!isText) {
		return (
			<p className="text-muted-foreground text-sm">
				{t("binaryChangedCommit")}
			</p>
		);
	}
	if (guarded && !revealed) {
		return (
			<div className="flex flex-col items-start gap-1">
				<p className="text-muted-foreground text-sm">
					{t("diffHidden", {
						kind: kindLabels[kind] ?? kindLabels.OTHER,
					})}
				</p>
				<Button
					variant="link"
					className="h-auto px-0"
					onClick={() => setRevealed(true)}
				>
					{t("showDiffButton")}
				</Button>
			</div>
		);
	}
	if (fromQuery.isError || toQuery.isError) {
		return (
			<p role="alert" className="text-destructive text-sm">
				{t("diffError")}
			</p>
		);
	}
	if (!fromQuery.isSuccess || !toQuery.isSuccess) {
		return <Skeleton className="h-24 w-full" />;
	}
	const from = fromQuery.data as CommitFile;
	const to = toQuery.data as CommitFile;
	const line = unavailableLine([from, to]);
	if (line !== null) {
		return <p className="text-muted-foreground text-sm">{t(line)}</p>;
	}
	return (
		<InstructionDiffBody
			path={path}
			before={textOf(from)}
			after={textOf(to)}
			truncated={false}
		/>
	);
}
