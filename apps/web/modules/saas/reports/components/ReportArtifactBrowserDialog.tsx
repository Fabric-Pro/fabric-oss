"use client";
import { orpcClient } from "@shared/lib/orpc-client";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { useEffect, useState } from "react";

type Props = {
	executionId: string;
	organizationId: string;
	frameBasePath: string;
	loadingArtifactId?: string | null;
	onClose: () => void;
	onView: (id: string, name: string) => void;
	onShare: (id: string, name: string) => void;
	onHistory: (id: string, name: string) => void;
	onEmail: (id: string, name: string) => void;
};
export function ReportArtifactBrowserDialog(props: Props) {
	type Page = Awaited<ReturnType<typeof orpcClient.reports.artifacts.list>>;
	const [page, setPage] = useState<Page>();
	const [cursors, setCursors] = useState<Array<string | undefined>>([
		undefined,
	]);
	const [loading, setLoading] = useState(true);
	const [failed, setFailed] = useState(false);
	const [type, setType] = useState("all");
	const cursor = cursors.at(-1);
	useEffect(() => {
		let active = true;
		setLoading(true);
		setFailed(false);
		void orpcClient.reports.artifacts
			.list({
				executionId: props.executionId,
				organizationId: props.organizationId,
				cursor,
				limit: 20,
				...(type !== "all" ? { artifactType: type as "PDF" } : {}),
			})
			.then((result) => {
				if (active) {
					setPage(result);
				}
			})
			.catch(() => {
				if (active) {
					setPage(undefined);
					setFailed(true);
				}
			})
			.finally(() => {
				if (active) {
					setLoading(false);
				}
			});
		return () => {
			active = false;
		};
	}, [props.executionId, props.organizationId, cursor, type]);
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) {
					props.onClose();
				}
			}}
		>
			<DialogContent className="max-w-3xl">
				<DialogHeader>
					<DialogTitle>Saved report outputs</DialogTitle>
					<DialogDescription>
						Exact outputs from this run. Access is checked again
						before every preview, download or share.
					</DialogDescription>
				</DialogHeader>
				<label className="flex items-center gap-2 text-sm">
					Format
					<select
						className="rounded-md border bg-background p-2"
						value={type}
						onChange={(event) => {
							setType(event.target.value);
							setCursors([undefined]);
						}}
					>
						<option value="all">All formats</option>
						{[
							"MARKDOWN",
							"PDF",
							"HTML",
							"CSV",
							"JSON",
							"EVIDENCE_EMBED",
							"CHART_DATA",
						].map((value) => (
							<option key={value}>{value}</option>
						))}
					</select>
				</label>
				<div className="max-h-[55vh] overflow-y-auto">
					{loading ? (
						<output>Loading outputs…</output>
					) : failed ? (
						<p role="alert">
							Outputs could not be loaded. Close this view and try
							again.
						</p>
					) : page?.artifacts.length ? (
						<ul className="divide-y">
							{page.artifacts.map((artifact) => (
								<li
									key={artifact.id}
									className="space-y-2 py-3"
								>
									<div className="flex flex-wrap justify-between gap-2">
										<span className="min-w-0 break-words font-medium">
											{artifact.name}
										</span>
										<span className="text-xs text-muted-foreground">
											{artifact.artifactType}
											{artifact.size !== null
												? ` · ${(artifact.size / 1024).toFixed(1)} KiB`
												: ""}
										</span>
									</div>
									<div className="flex flex-wrap gap-2">
										<Button
											variant="outline"
											size="sm"
											disabled={!!props.loadingArtifactId}
											aria-busy={
												props.loadingArtifactId ===
												artifact.id
											}
											onClick={() =>
												props.onView(
													artifact.id,
													artifact.name,
												)
											}
										>
											{props.loadingArtifactId ===
											artifact.id
												? "Opening preview…"
												: "Preview"}
										</Button>
										<Button
											variant="outline"
											size="sm"
											asChild
										>
											<a
												href={`/api/reports/artifacts/${encodeURIComponent(artifact.id)}/download`}
												download
											>
												Download
											</a>
										</Button>
										{artifact.linkedFrameId && (
											<Button
												variant="outline"
												size="sm"
												asChild
											>
												<a
													href={`${props.frameBasePath}/${encodeURIComponent(artifact.linkedFrameId)}`}
												>
													Open document
												</a>
											</Button>
										)}
										<Button
											variant="outline"
											size="sm"
											onClick={() =>
												props.onShare(
													artifact.id,
													artifact.name,
												)
											}
										>
											Share to inbox
										</Button>
										<Button
											variant="outline"
											size="sm"
											onClick={() =>
												props.onEmail(
													artifact.id,
													artifact.name,
												)
											}
										>
											Send email
										</Button>
										<Button
											variant="ghost"
											size="sm"
											onClick={() =>
												props.onHistory(
													artifact.id,
													artifact.name,
												)
											}
										>
											Delivery history
										</Button>
									</div>
								</li>
							))}
						</ul>
					) : (
						<p className="py-6 text-sm text-muted-foreground">
							No available outputs for this format.
						</p>
					)}
				</div>
				<DialogFooter className="items-center sm:justify-between">
					<span className="text-sm text-muted-foreground">
						Page {cursors.length}
					</span>
					<div className="flex gap-2">
						<Button
							variant="outline"
							disabled={loading || cursors.length === 1}
							onClick={() =>
								setCursors((value) => value.slice(0, -1))
							}
						>
							Previous outputs
						</Button>
						<Button
							variant="outline"
							disabled={
								loading || !page?.hasMore || !page.nextCursor
							}
							onClick={() => {
								const next = page?.nextCursor;
								if (next) {
									setCursors((value) => [...value, next]);
								}
							}}
						>
							Next outputs
						</Button>
						<Button variant="outline" onClick={props.onClose}>
							Close
						</Button>
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
