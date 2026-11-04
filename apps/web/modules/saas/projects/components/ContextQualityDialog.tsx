"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { Alert, AlertDescription } from "@ui/components/alert";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { Textarea } from "@ui/components/textarea";
import { CheckCheckIcon, DownloadIcon, Loader2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { triggerBlobDownload } from "../lib/markdown-to-document";
import { AgentResultQualityDialog } from "./AgentResultQualityDialog";
import { ContextQualitySettings } from "./ContextQualitySettings";
import { getOrpcCode } from "./field-mapping/orpc-error";
import { SavedContextQualityRuns } from "./SavedContextQualityRuns";

interface ContextQualitySourceChoice {
	id: string;
	title: string;
	/** Current list revision hint only; the inspection supplies the exact body pin. */
	version?: string;
}

interface Props {
	projectId: string;
	organizationId: string | null;
	sources: ContextQualitySourceChoice[];
	agentExecutionId?: string;
	improveHref?: string;
}

type InspectedSource = Awaited<
	ReturnType<typeof orpcClient.contextQuality.inspect>
>;
type Result = Awaited<ReturnType<typeof orpcClient.contextQuality.evaluate>>;
type Capabilities = Awaited<
	ReturnType<typeof orpcClient.contextQuality.runs.capabilities>
>;
type Inspection = Omit<InspectedSource, "content"> & {
	preview: string;
	previewTruncated: boolean;
};

function phrases(value: string): string[] {
	return [
		...new Set(
			value
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean),
		),
	];
}

function errorKey(error: unknown) {
	switch (getOrpcCode(error)) {
		case "FORBIDDEN":
		case "UNAUTHORIZED":
			return "errorDenied";
		case "NOT_FOUND":
			return "errorUnavailable";
		case "CONFLICT":
			return "errorStale";
		case "PAYLOAD_TOO_LARGE":
			return "errorTooLarge";
		case "BAD_REQUEST":
			return "errorInvalid";
		case "PRECONDITION_FAILED":
			return "saved.notConfigured";
		default:
			return "errorGeneric";
	}
}

/**
 * One Context quality workspace: local recorded-output checks and explicitly
 * saved evaluations on the project's approved Databricks binding.
 */
export function ContextQualityDialog(props: Props) {
	return props.agentExecutionId && props.organizationId ? (
		<AgentResultQualityDialog
			key={JSON.stringify([
				props.projectId,
				props.organizationId,
				props.agentExecutionId,
			])}
			projectId={props.projectId}
			organizationId={props.organizationId}
			executionId={props.agentExecutionId}
			improveHref={props.improveHref}
		/>
	) : (
		<ManualContextQualityDialog {...props} />
	);
}
function ManualContextQualityDialog({
	projectId,
	organizationId,
	sources,
}: Props) {
	const t = useTranslations("projects.contexts.quality");
	const id = useId();
	const generation = useRef(0);
	const [open, setOpen] = useState(false);
	const [activeTab, setActiveTab] = useState("check");
	const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
	const [configurationVersion, setConfigurationVersion] = useState(0);
	const [capabilityFailed, setCapabilityFailed] = useState(false);
	const [savedName, setSavedName] = useState("");
	const [seedRunId, setSeedRunId] = useState("");
	const capabilityGeneration = useRef(0);
	const submission = useRef<{ fingerprint: string; key: string } | null>(
		null,
	);
	const saving = useRef(false);
	const historyTab = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (activeTab === "history") {
			historyTab.current?.focus();
		}
	}, [activeTab]);
	useEffect(() => {
		const request = ++capabilityGeneration.current;
		setCapabilities(null);
		setCapabilityFailed(false);
		if (!open || !organizationId) {
			return;
		}
		void (async () => {
			try {
				const response =
					await orpcClient.contextQuality.runs.capabilities({
						projectId,
						organizationId,
					});
				if (request === capabilityGeneration.current) {
					setCapabilities(response);
				}
			} catch {
				if (request === capabilityGeneration.current) {
					setCapabilityFailed(true);
				}
			}
		})();
		return () => {
			capabilityGeneration.current += 1;
		};
	}, [open, projectId, organizationId, configurationVersion]);
	const [sourceId, setSourceId] = useState("");
	const [inspection, setInspection] = useState<Inspection | null>(null);
	const [recordedAnswer, setRecordedAnswer] = useState("");
	const [required, setRequired] = useState("");
	const [forbidden, setForbidden] = useState("");
	const [citesSource, setCitesSource] = useState(false);
	const [requireCitation, setRequireCitation] = useState(false);
	const [busy, setBusy] = useState<"inspect" | "evaluate" | "save" | null>(
		null,
	);
	const [error, setError] = useState<
		ReturnType<typeof errorKey> | "saved.createError" | null
	>(null);
	const [result, setResult] = useState<Result | null>(null);
	const scopeFingerprint = JSON.stringify([projectId, organizationId]);
	const lastScope = useRef(scopeFingerprint);
	const sourceFingerprint = JSON.stringify(sources);
	const selectedSourceAvailable = sources.some(
		(source) => source.id === sourceId,
	);

	// A refreshed inventory/scope invalidates evidence even if the chosen id is
	// unchanged. Late responses from the old scope must never repopulate the dialog.
	useEffect(() => {
		void sourceFingerprint;
		generation.current += 1;
		setInspection(null);
		setResult(null);
		setError(null);
		setBusy(null);
		if (lastScope.current !== scopeFingerprint) {
			lastScope.current = scopeFingerprint;
			setSourceId("");
			setActiveTab("check");
			setSeedRunId("");
			setSavedName("");
			submission.current = null;
			setRecordedAnswer("");
			setRequired("");
			setForbidden("");
			setCitesSource(false);
			setRequireCitation(false);
		} else if (!selectedSourceAvailable) {
			setSourceId("");
		}
	}, [sourceFingerprint, scopeFingerprint, selectedSourceAvailable]);

	useEffect(
		() => () => {
			generation.current += 1;
		},
		[],
	);

	function invalidateResult() {
		generation.current += 1;
		setResult(null);
		setError(null);
	}

	function changeOpen(nextOpen: boolean) {
		setOpen(nextOpen);
		if (!nextOpen) {
			invalidateResult();
			setActiveTab("check");
			setSeedRunId("");
			setSavedName("");
			submission.current = null;
			setSourceId("");
			setInspection(null);
			setRecordedAnswer("");
			setRequired("");
			setForbidden("");
			setCitesSource(false);
			setRequireCitation(false);
			setBusy(null);
		}
	}

	async function inspect() {
		if (!sourceId || !selectedSourceAvailable || !organizationId || busy) {
			return;
		}
		const request = ++generation.current;
		setBusy("inspect");
		setInspection(null);
		setResult(null);
		setError(null);
		try {
			const response = await orpcClient.contextQuality.inspect({
				projectId,
				organizationId,
				sourceId,
			});
			if (request !== generation.current) {
				return;
			}
			const { content, ...reference } = response;
			setInspection({
				...reference,
				preview: Array.from(content).slice(0, 2000).join(""),
				previewTruncated: Array.from(content).length > 2000,
			});
		} catch (failure) {
			if (request === generation.current) {
				setError(errorKey(failure));
			}
		} finally {
			if (request === generation.current) {
				setBusy(null);
			}
		}
	}

	const requiredPhrases = phrases(required);
	const forbiddenPhrases = phrases(forbidden);
	const validRequired =
		requiredPhrases.length <= 20 &&
		requiredPhrases.every((phrase) => phrase.length <= 512);
	const validForbidden =
		forbiddenPhrases.length <= 20 &&
		forbiddenPhrases.every((phrase) => phrase.length <= 512);
	const validPhrases = validRequired && validForbidden;
	const hasExpectation =
		requireCitation ||
		requiredPhrases.length > 0 ||
		forbiddenPhrases.length > 0;
	const canEvaluate = Boolean(
		organizationId &&
			inspection &&
			selectedSourceAvailable &&
			inspection.sourceId === sourceId &&
			inspection.projectId === projectId &&
			inspection.organizationId === organizationId &&
			recordedAnswer.trim() &&
			recordedAnswer.length <= 16_384 &&
			validPhrases &&
			hasExpectation &&
			!busy,
	);

	function evaluationInput(pin: Inspection) {
		return {
			version: 1 as const,
			sources: [{ sourceId, expectedRevision: pin.revision }],
			cases: [
				{
					id: "case-1",
					recordedAnswer,
					retrievedSourceIds: [sourceId],
					citedSourceIds: citesSource ? [sourceId] : [],
					expectations: {
						expectedSourceIds: requireCitation ? [sourceId] : [],
						requiredPhrases,
						forbiddenPhrases,
					},
				},
			],
		};
	}

	async function evaluate() {
		if (!canEvaluate || !inspection || !organizationId) {
			return;
		}
		const request = ++generation.current;
		setBusy("evaluate");
		setResult(null);
		setError(null);
		try {
			const response = await orpcClient.contextQuality.evaluate({
				projectId,
				organizationId,
				evaluation: evaluationInput(inspection),
			});
			if (request === generation.current) {
				setResult(response);
			}
		} catch (failure) {
			if (request === generation.current) {
				if (
					[
						"FORBIDDEN",
						"UNAUTHORIZED",
						"NOT_FOUND",
						"CONFLICT",
					].includes(getOrpcCode(failure) ?? "")
				) {
					setInspection(null);
				}
				setError(errorKey(failure));
			}
		} finally {
			if (request === generation.current) {
				setBusy(null);
			}
		}
	}

	async function saveEvaluation() {
		if (
			!canEvaluate ||
			!inspection ||
			!organizationId ||
			saving.current ||
			!capabilities?.configured ||
			!capabilities.canCreate ||
			!capabilities.bindingId
		) {
			return;
		}
		const evaluation = evaluationInput(inspection);
		const name = savedName.trim() || undefined;
		const fingerprint = JSON.stringify({
			projectId,
			organizationId,
			bindingId: capabilities.bindingId,
			name,
			evaluation,
		});
		if (submission.current?.fingerprint !== fingerprint) {
			submission.current = { fingerprint, key: crypto.randomUUID() };
		}
		const request = ++generation.current;
		saving.current = true;
		setBusy("save");
		setResult(null);
		setError(null);
		try {
			const response = await orpcClient.contextQuality.runs.create({
				projectId,
				organizationId,
				bindingId: capabilities.bindingId,
				idempotencyKey: submission.current.key,
				name,
				evaluation,
			});
			if (request === generation.current) {
				submission.current = null;
				setSeedRunId(response.run.id);
				setActiveTab("history");
			}
		} catch (failure) {
			if (request === generation.current) {
				if (
					[
						"FORBIDDEN",
						"UNAUTHORIZED",
						"NOT_FOUND",
						"CONFLICT",
					].includes(getOrpcCode(failure) ?? "")
				) {
					setInspection(null);
				}
				const key = errorKey(failure);
				setError(key === "errorGeneric" ? "saved.createError" : key);
			}
		} finally {
			saving.current = false;
			if (request === generation.current) {
				setBusy(null);
			}
		}
	}

	return (
		<Dialog open={open} onOpenChange={changeOpen}>
			<DialogTrigger asChild>
				<Button
					type="button"
					variant="outline"
					disabled={!organizationId}
					aria-describedby={`${id}-availability`}
				>
					<CheckCheckIcon
						className="mr-2 size-4"
						aria-hidden="true"
					/>
					{t("trigger")}
				</Button>
			</DialogTrigger>
			<span id={`${id}-availability`} className="sr-only">
				{t("description")}
			</span>
			<DialogContent className="w-[calc(100%-2rem)] max-w-3xl grid-cols-[minmax(0,1fr)]">
				<DialogHeader>
					<DialogTitle>{t("title")}</DialogTitle>
					<DialogDescription>{t("description")}</DialogDescription>
				</DialogHeader>
				<Tabs
					className="min-w-0"
					value={activeTab}
					onValueChange={setActiveTab}
				>
					<TabsList aria-label={t("saved.views")}>
						<TabsTrigger value="check">
							{t("saved.quick")}
						</TabsTrigger>
						<TabsTrigger value="history" ref={historyTab}>
							{t("saved.title")}
						</TabsTrigger>
						{capabilities?.canConfigure && (
							<TabsTrigger value="settings">
								{t("setup.title")}
							</TabsTrigger>
						)}
					</TabsList>
					{capabilities?.canConfigure && organizationId && (
						<TabsContent value="settings">
							<ContextQualitySettings
								projectId={projectId}
								organizationId={organizationId}
								onSaved={() =>
									setConfigurationVersion((n) => n + 1)
								}
							/>
						</TabsContent>
					)}
					<TabsContent value="history">
						{organizationId && (
							<SavedContextQualityRuns
								key={scopeFingerprint + sourceFingerprint}
								projectId={projectId}
								organizationId={organizationId}
								canCancel={capabilities?.canCancel ?? false}
								seedRunId={seedRunId || undefined}
							/>
						)}
					</TabsContent>
					<TabsContent value="check" className="space-y-4">
						<p className="text-sm text-muted-foreground">
							{t("scopeNotice")}
						</p>
						{sources.length === 0 && (
							<p className="text-sm text-muted-foreground">
								{t("noSources")}
							</p>
						)}
						<div className="space-y-3">
							<Label htmlFor={`${id}-source`}>
								{t("source")}
							</Label>
							<div className="flex flex-col gap-2 sm:flex-row">
								<Select
									value={sourceId}
									disabled={Boolean(busy)}
									onValueChange={(value) => {
										invalidateResult();
										setSourceId(value);
										setInspection(null);
									}}
								>
									<SelectTrigger
										id={`${id}-source`}
										className="min-w-0 flex-1"
										aria-describedby={`${id}-source-hint`}
									>
										<SelectValue
											placeholder={t("chooseSource")}
										/>
									</SelectTrigger>
									<SelectContent>
										{sources.map((source) => (
											<SelectItem
												key={source.id}
												value={source.id}
											>
												{source.title}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<Button
									type="button"
									variant="outline"
									onClick={inspect}
									disabled={
										!selectedSourceAvailable ||
										!organizationId ||
										Boolean(busy)
									}
									aria-busy={busy === "inspect"}
								>
									{busy === "inspect" && (
										<Loader2Icon
											className="mr-2 size-4 animate-spin"
											aria-hidden="true"
										/>
									)}
									{t(
										busy === "inspect"
											? "inspecting"
											: "inspect",
									)}
								</Button>
							</div>
							<p
								id={`${id}-source-hint`}
								className="text-xs text-muted-foreground"
							>
								{t("sourceHint")}
							</p>
							{selectedSourceAvailable && !inspection && (
								<p
									className="text-xs text-muted-foreground"
									aria-live="polite"
								>
									{t("inspectionRequired")}
								</p>
							)}
							{inspection && (
								<div
									className="space-y-2 border-t border-border pt-3"
									data-testid="context-quality-inspection"
								>
									<div className="flex flex-wrap items-center gap-2">
										<span className="text-xs text-muted-foreground">
											{t("bytes", {
												count: inspection.byteLength,
											})}
										</span>
										{inspection.indexingExcluded && (
											<Badge variant="outline">
												{t("storeOnly")}
											</Badge>
										)}
									</div>
									<p className="text-xs text-muted-foreground">
										{t("revision")}
										<code className="mt-1 block break-all text-foreground">
											{inspection.revision}
										</code>
									</p>
									<details>
										<summary className="cursor-pointer text-sm">
											{t("preview")}
										</summary>
										<pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs">
											{inspection.preview}
										</pre>
										{inspection.previewTruncated && (
											<p className="mt-2 text-xs text-muted-foreground">
												{t("previewTruncated", {
													count: 2000,
												})}
											</p>
										)}
									</details>
								</div>
							)}
						</div>
						<div className="space-y-4 border-t border-border pt-4">
							<div className="space-y-2">
								<Label htmlFor={`${id}-answer`}>
									{t("recordedAnswer")}
								</Label>
								<Textarea
									id={`${id}-answer`}
									value={recordedAnswer}
									disabled={Boolean(busy)}
									maxLength={16_384}
									rows={4}
									onChange={(event) => {
										invalidateResult();
										setRecordedAnswer(event.target.value);
									}}
								/>
							</div>
							<div className="grid gap-4 sm:grid-cols-2">
								<div className="space-y-2">
									<Label htmlFor={`${id}-required`}>
										{t("required")}
									</Label>
									<Textarea
										id={`${id}-required`}
										rows={3}
										value={required}
										disabled={Boolean(busy)}
										maxLength={10_260}
										aria-invalid={!validRequired}
										aria-describedby={`${id}-phrase-hint`}
										onChange={(event) => {
											invalidateResult();
											setRequired(event.target.value);
										}}
									/>
								</div>
								<div className="space-y-2">
									<Label htmlFor={`${id}-forbidden`}>
										{t("forbidden")}
									</Label>
									<Textarea
										id={`${id}-forbidden`}
										rows={3}
										value={forbidden}
										disabled={Boolean(busy)}
										maxLength={10_260}
										aria-invalid={!validForbidden}
										aria-describedby={`${id}-phrase-hint`}
										onChange={(event) => {
											invalidateResult();
											setForbidden(event.target.value);
										}}
									/>
								</div>
							</div>
							<p
								id={`${id}-phrase-hint`}
								className={
									validPhrases
										? "text-xs text-muted-foreground"
										: "text-xs text-destructive"
								}
							>
								{t("phraseHint")}
							</p>
							<div className="flex items-start gap-2">
								<Checkbox
									id={`${id}-require-citation`}
									checked={requireCitation}
									disabled={Boolean(busy)}
									onCheckedChange={(value) => {
										invalidateResult();
										setRequireCitation(value === true);
									}}
								/>
								<Label htmlFor={`${id}-require-citation`}>
									{t("requireCitation")}
								</Label>
							</div>
							{!hasExpectation && (
								<p
									className="text-xs text-muted-foreground"
									aria-live="polite"
								>
									{t("expectationHint")}
								</p>
							)}
							<div className="space-y-2">
								<div className="flex items-start gap-2">
									<Checkbox
										id={`${id}-citation`}
										checked={citesSource}
										disabled={Boolean(busy)}
										onCheckedChange={(value) => {
											invalidateResult();
											setCitesSource(value === true);
										}}
										aria-describedby={`${id}-citation-hint`}
									/>
									<Label htmlFor={`${id}-citation`}>
										{t("citation")}
									</Label>
								</div>
								<p
									id={`${id}-citation-hint`}
									className="text-xs text-muted-foreground"
								>
									{t("citationHint")}
								</p>
							</div>
						</div>
						{error && (
							<Alert variant="error">
								<AlertDescription>{t(error)}</AlertDescription>
							</Alert>
						)}
						{result && (
							<section
								className="space-y-3 border-t border-border pt-4"
								aria-label={t("result")}
							>
								<div className="flex flex-wrap items-center justify-between gap-2">
									<Badge
										variant={
											result.status === "passed"
												? "success"
												: "error"
										}
										role="status"
									>
										{t(
											result.status === "passed"
												? "passed"
												: "failed",
										)}
									</Badge>
									<Button
										type="button"
										variant="outline"
										size="sm"
										onClick={() => {
											try {
												triggerBlobDownload(
													new Blob(
														[
															JSON.stringify(
																result,
																null,
																2,
															),
														],
														{
															type: "application/json",
														},
													),
													"context-quality-report.json",
												);
											} catch {
												setError("errorGeneric");
											}
										}}
									>
										<DownloadIcon
											className="mr-2 size-4"
											aria-hidden="true"
										/>
										{t("download")}
									</Button>
								</div>
								<p className="text-xs text-muted-foreground">
									{t("resultHelp")}
								</p>
								<ul className="divide-y divide-border">
									{result.cases.flatMap((entry) =>
										entry.checks.map((check) => (
											<li
												key={`${entry.id}-${check.id}`}
												className="flex items-center justify-between gap-3 py-2 text-sm"
											>
												<span>
													{t(`checks.${check.id}`)}
												</span>
												<span
													className={
														check.status ===
														"passed"
															? "text-success"
															: "text-destructive"
													}
												>
													{t(
														check.status ===
															"passed"
															? "checkPassed"
															: "checkFailed",
													)}
												</span>
											</li>
										)),
									)}
								</ul>
								<details>
									<summary className="cursor-pointer text-sm">
										{t("reportDetails")}
									</summary>
									<p className="mt-2 text-xs text-muted-foreground">
										{result.scorerVersion}
									</p>
									<code className="mt-1 block break-all text-xs">
										{result.snapshotHash}
									</code>
								</details>
							</section>
						)}
						<p className="text-xs text-muted-foreground">
							{t("stateless")}
						</p>
						<section
							className="space-y-3 border-t border-border pt-4"
							aria-label={t("saved.create")}
						>
							<p className="text-sm text-muted-foreground">
								{t("saved.exportNotice")}
							</p>
							{capabilityFailed && (
								<p className="text-sm text-destructive">
									{t("saved.capabilityError")}
								</p>
							)}
							{capabilities && !capabilities.configured && (
								<p className="text-sm text-muted-foreground">
									{t("saved.notConfigured")}
								</p>
							)}
							{capabilities?.configured &&
								!capabilities.canCreate && (
									<p className="text-sm text-muted-foreground">
										{t("saved.readOnly")}
									</p>
								)}
							{capabilities?.configured &&
								capabilities.canCreate && (
									<div className="space-y-2">
										<Label htmlFor={`${id}-saved-name`}>
											{t("saved.nameOptional")}
										</Label>
										<Input
											id={`${id}-saved-name`}
											value={savedName}
											maxLength={80}
											disabled={Boolean(busy)}
											onChange={(event) =>
												setSavedName(event.target.value)
											}
										/>
										<Button
											type="button"
											variant="outline"
											disabled={
												!canEvaluate ||
												!capabilities.bindingId
											}
											aria-busy={busy === "save"}
											onClick={saveEvaluation}
										>
											{t(
												busy === "save"
													? "saved.creating"
													: "saved.create",
											)}
										</Button>
									</div>
								)}
						</section>
					</TabsContent>
				</Tabs>
				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={() => changeOpen(false)}
					>
						{t("close")}
					</Button>
					{activeTab === "check" && (
						<Button
							type="button"
							onClick={evaluate}
							disabled={!canEvaluate}
							aria-busy={busy === "evaluate"}
						>
							{busy === "evaluate" && (
								<Loader2Icon
									className="mr-2 size-4 animate-spin"
									aria-hidden="true"
								/>
							)}
							{t(busy === "evaluate" ? "running" : "run")}
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
