"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Skeleton } from "@ui/components/skeleton";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { InstructionDiffBody } from "./InstructionDiffBody";

/** The cap `getFile` accepts, and the one the file reader already uses. */
const BODY_MAX_LENGTH = 200_000;

/**
 * Kinds whose body is not rendered as a diff until somebody asks for it.
 *
 * A script and a settings file are the two things in a version that RUN
 * rather than being read as prose, and a reviewer scrolling a long list of
 * changes should not have one unrolled into their view by default.
 */
const GUARDED_KINDS = new Set(["SCRIPT", "SETTINGS"]);

type FileBody = {
	body: string | null;
	truncated: boolean;
};

/**
 * One changed file's unified body diff, fetched only once the row it sits in
 * has been expanded.
 *
 * Deliberately two `getFile` calls from the client rather than a body-bearing
 * compare endpoint: `compare` answers a whole version in two list queries and
 * never touches storage, so a version with 400 changed files costs the same as
 * one with two. The bytes are read for the handful of rows a person actually
 * opens, through the paged, gated reader (`get-file.ts`) that already refuses
 * a non-READY or undecided-proposal snapshot.
 */
export function InstructionFileDiff({
	projectId,
	fromSnapshotId,
	toSnapshotId,
	path,
	kind,
	isText,
}: {
	projectId: string;
	fromSnapshotId: string;
	toSnapshotId: string;
	path: string;
	kind: string;
	/** False when either side is binary — there is no line diff to draw. */
	isText: boolean;
}) {
	const t = useTranslations("projects.codingInstructions.compare");
	const [revealed, setRevealed] = useState(false);
	const guarded = GUARDED_KINDS.has(kind);
	const kindLabels = useTranslations(
		"projects.codingInstructions.fileView",
	).raw("kindLabels") as Record<string, string>;
	// Neither side is read for a binary file, nor for a guarded kind before
	// the button is pressed: `enabled` is what keeps that promise, not an
	// early return, since the hooks below run on every render.
	const shouldFetch = isText && (!guarded || revealed);
	const fromQuery = useQuery({
		...orpc.projects.instructions.getFile.queryOptions({
			input: {
				projectId,
				snapshotId: fromSnapshotId,
				path,
				offset: 0,
				maxLength: BODY_MAX_LENGTH,
			},
		}),
		enabled: shouldFetch,
	});
	const toQuery = useQuery({
		...orpc.projects.instructions.getFile.queryOptions({
			input: {
				projectId,
				snapshotId: toSnapshotId,
				path,
				offset: 0,
				maxLength: BODY_MAX_LENGTH,
			},
		}),
		enabled: shouldFetch,
	});
	if (!isText) {
		return (
			<p className="text-muted-foreground text-sm">
				{t("binaryChanged")}
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
	return (
		<InstructionDiffBody
			path={path}
			before={(fromQuery.data as FileBody).body ?? ""}
			after={(toQuery.data as FileBody).body ?? ""}
			truncated={
				(fromQuery.data as FileBody).truncated ||
				(toQuery.data as FileBody).truncated
			}
		/>
	);
}
