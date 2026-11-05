"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { Alert, AlertDescription } from "@ui/components/alert";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@ui/components/dialog";
import { Label } from "@ui/components/label";
import { Textarea } from "@ui/components/textarea";
import { CheckCheckIcon, DownloadIcon, Loader2Icon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { triggerBlobDownload } from "../lib/markdown-to-document";

type Snapshot = Awaited<
	ReturnType<typeof orpcClient.contextQuality.agentResults.inspect>
>;
type Check = Awaited<
	ReturnType<typeof orpcClient.contextQuality.agentResults.evaluate>
>;
const phrases = (text: string) => [
	...new Set(
		text
			.split("\n")
			.map((v) => v.trim())
			.filter(Boolean),
	),
];

/** Owner-only recorded-run mode of Quality. No shared save, provider call or automatic edit. */
export function AgentResultQualityDialog({
	projectId,
	organizationId,
	executionId,
	improveHref,
}: {
	projectId: string;
	organizationId: string;
	executionId: string;
	improveHref?: string;
}) {
	const t = useTranslations("projects.contexts.quality.agentResult");
	const id = useId();
	const [open, setOpen] = useState(false);
	const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
	const [result, setResult] = useState<Check | null>(null);
	const [required, setRequired] = useState("");
	const [forbidden, setForbidden] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(false);
	const generation = useRef(0);
	const pending = useRef(false);
	useEffect(
		() => () => {
			generation.current++;
		},
		[],
	);
	const must = phrases(required);
	const avoid = phrases(forbidden);
	const valid =
		must.length <= 20 &&
		avoid.length <= 20 &&
		[...must, ...avoid].every((v) => v.length <= 512);
	async function inspect() {
		const request = ++generation.current;
		pending.current = true;
		setBusy(true);
		setError(false);
		setSnapshot(null);
		setResult(null);
		try {
			const next = await orpcClient.contextQuality.agentResults.inspect({
				projectId,
				organizationId,
				executionId,
			});
			if (request === generation.current) {
				setSnapshot(next);
			}
		} catch {
			if (request === generation.current) {
				setError(true);
			}
		} finally {
			if (request === generation.current) {
				pending.current = false;
				setBusy(false);
			}
		}
	}
	function changeOpen(next: boolean) {
		setOpen(next);
		if (next) {
			void inspect();
			return;
		}
		generation.current++;
		pending.current = false;
		setBusy(false);
		setSnapshot(null);
		setResult(null);
		setRequired("");
		setForbidden("");
		setError(false);
	}
	async function check(download = false) {
		if (
			pending.current ||
			!snapshot ||
			!valid ||
			(!must.length && !avoid.length)
		) {
			return;
		}
		pending.current = true;
		const request = ++generation.current;
		setBusy(true);
		setError(false);
		setResult(null);
		try {
			const checked =
				await orpcClient.contextQuality.agentResults.evaluate({
					projectId,
					organizationId,
					executionId,
					expectedRevision: snapshot.revision,
					requiredPhrases: must,
					forbiddenPhrases: avoid,
				});
			if (request !== generation.current) {
				return;
			}
			setResult(checked);
			if (download) {
				triggerBlobDownload(
					new Blob([JSON.stringify(checked, null, 2)], {
						type: "application/json",
					}),
					"agent-result-quality.json",
				);
			}
		} catch {
			if (request === generation.current) {
				setError(true);
				setSnapshot(null);
			}
		} finally {
			if (request === generation.current) {
				pending.current = false;
				setBusy(false);
			}
		}
	}
	return (
		<Dialog open={open} onOpenChange={changeOpen}>
			<DialogTrigger asChild>
				<Button variant="outline" size="sm">
					<CheckCheckIcon
						className="mr-2 size-4"
						aria-hidden="true"
					/>
					{t("trigger")}
				</Button>
			</DialogTrigger>
			<DialogContent className="w-[calc(100%-2rem)] max-w-3xl grid-cols-[minmax(0,1fr)]">
				<DialogHeader>
					<DialogTitle>{t("title")}</DialogTitle>
					<DialogDescription>{t("description")}</DialogDescription>
				</DialogHeader>
				<div className="flex flex-wrap items-center justify-between gap-2">
					<Badge
						variant={
							result
								? result.status === "passed"
									? "success"
									: "error"
								: "outline"
						}
						role="status"
					>
						{t(
							result
								? result.status === "passed"
									? "passed"
									: "failed"
								: "notEvaluated",
						)}
					</Badge>
					<Button
						variant="ghost"
						size="sm"
						disabled={busy}
						onClick={() => void inspect()}
					>
						{t("reload")}
					</Button>
				</div>
				<p className="text-sm text-muted-foreground">
					{t("scopeNotice")}
				</p>
				{busy && (
					<output className="flex items-center gap-2 text-sm">
						<Loader2Icon
							className="size-4 motion-safe:animate-spin"
							aria-hidden="true"
						/>
						{t("loading")}
					</output>
				)}
				{error && (
					<Alert variant="error">
						<AlertDescription>{t("error")}</AlertDescription>
					</Alert>
				)}
				{snapshot && (
					<>
						<div className="space-y-2">
							<Label htmlFor={`${id}-answer`}>
								{t("answer")}
							</Label>
							<Textarea
								id={`${id}-answer`}
								value={snapshot.recordedAnswer}
								readOnly
								rows={5}
							/>
							<p className="text-xs text-muted-foreground">
								{t("privateNotice")}
							</p>
						</div>
						<details>
							<summary className="cursor-pointer text-sm">
								{t("evidence")}
							</summary>
							<dl className="mt-2 space-y-2 text-xs">
								<dt>{t("recordSource")}</dt>
								<dd>
									{t(
										snapshot.executionStateSource ===
											"temporal"
											? "liveRecord"
											: "savedRecord",
									)}
								</dd>
								<dt>{t("runId")}</dt>
								<dd className="break-all">
									{snapshot.executionId}
								</dd>
								<dt>{t("revision")}</dt>
								<dd className="break-all font-mono">
									{snapshot.revision}
								</dd>
							</dl>
						</details>
					</>
				)}
				<div className="grid gap-4 sm:grid-cols-2">
					<div className="space-y-2">
						<Label htmlFor={`${id}-required`}>
							{t("required")}
						</Label>
						<Textarea
							id={`${id}-required`}
							value={required}
							maxLength={10260}
							rows={3}
							disabled={busy}
							aria-describedby={`${id}-hint`}
							onChange={(e) => {
								setRequired(e.target.value);
								setResult(null);
							}}
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor={`${id}-forbidden`}>
							{t("forbidden")}
						</Label>
						<Textarea
							id={`${id}-forbidden`}
							value={forbidden}
							maxLength={10260}
							rows={3}
							disabled={busy}
							aria-describedby={`${id}-hint`}
							onChange={(e) => {
								setForbidden(e.target.value);
								setResult(null);
							}}
						/>
					</div>
				</div>
				<p
					id={`${id}-hint`}
					className={
						valid
							? "text-xs text-muted-foreground"
							: "text-xs text-destructive"
					}
				>
					{t("phraseHint")}
				</p>
				<div className="flex flex-wrap gap-2">
					<Button
						disabled={
							busy ||
							!snapshot ||
							!valid ||
							(!must.length && !avoid.length)
						}
						onClick={() => void check()}
					>
						{t("check")}
					</Button>
					{result && (
						<Button
							variant="outline"
							disabled={busy}
							onClick={() => void check(true)}
						>
							<DownloadIcon
								className="mr-2 size-4"
								aria-hidden="true"
							/>
							{t("download")}
						</Button>
					)}
				</div>
				{result && (
					<section
						className="space-y-3 border-t border-border pt-4"
						aria-label={t("results")}
					>
						<h3 className="text-sm font-semibold">
							{t("results")}
						</h3>
						<ul className="divide-y divide-border">
							{result.expectationResults.map((entry, index) => (
								<li
									key={`${entry.kind}:${index}`}
									className="flex items-start justify-between gap-3 py-2 text-sm"
								>
									<span className="min-w-0 break-words">
										{t(
											entry.kind === "required"
												? "include"
												: "exclude",
										)}{" "}
										<q>{entry.phrase}</q>
									</span>
									<span
										className={
											entry.passed
												? "shrink-0 text-success"
												: "shrink-0 text-destructive"
										}
									>
										{t(
											entry.passed
												? "checkPassed"
												: "checkFailed",
										)}
									</span>
								</li>
							))}
						</ul>
						<p className="text-xs text-muted-foreground">
							{t("resultHelp")}
						</p>
						{improveHref && (
							<>
								<Button variant="outline" asChild>
									<Link href={improveHref}>
										{t("improve")}
									</Link>
								</Button>
								<p className="text-xs text-muted-foreground">
									{t("improveHint")}
								</p>
							</>
						)}
					</section>
				)}
			</DialogContent>
		</Dialog>
	);
}
