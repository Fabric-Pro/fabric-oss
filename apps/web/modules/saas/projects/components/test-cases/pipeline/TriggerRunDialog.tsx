"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
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
import {
	CircleCheckIcon,
	ExternalLinkIcon,
	Loader2Icon,
	PlayIcon,
	TriangleAlertIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

type TriggerOutcome =
	| { ok: true; runId: string | null; runUrl: string | null }
	| { ok: false; failure: string; message: string };

type Props = {
	projectId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Poll for freshly-ingested runs once a run has actually been queued. */
	onTriggered: () => void;
};

/**
 * Start a run in the customer's existing CI.
 *
 * Fabric queues the run and stops there — the result arrives through the normal
 * pipeline-results sync, so this dialog never pretends to know the outcome.
 *
 * The refusal path is the interesting one. A GitHub workflow that declares no
 * `workflow_dispatch:` trigger, or a token that can read CI but not start it,
 * are things only the customer can fix, so those answers render as a persistent
 * panel with the exact remedy rather than a toast that disappears before it can
 * be read.
 */
export function TriggerRunDialog({
	projectId,
	open,
	onOpenChange,
	onTriggered,
}: Props) {
	const t = useTranslations(
		"projects.stories.maturation.qa.pipelineRuns.run",
	);
	const queryClient = useQueryClient();

	const [integrationId, setIntegrationId] = useState<string | null>(null);
	const [pipelineId, setPipelineId] = useState<string | null>(null);
	const [ref, setRef] = useState("");
	const [outcome, setOutcome] = useState<TriggerOutcome | null>(null);

	const sourcesQuery = useQuery({
		...orpc.projects.pipelineResults.triggerable.queryOptions({
			input: { projectId },
		}),
		// Listing hits each provider's API with a stored credential, so it waits
		// until someone actually intends to start a run.
		enabled: open,
		// Opt out of the app-wide 60s staleTime. The most common reason to reopen
		// this dialog is that a listed source reported a credential error and the
		// user has just gone and fixed it — serving that stale error back for
		// another minute makes reopening look broken, with nothing to retry.
		staleTime: 0,
	});
	const sources = sourcesQuery.data ?? [];
	const source =
		sources.find((s) => s.integrationId === integrationId) ?? null;

	// Re-arm the verdict each time the dialog OPENS — and only then.
	//
	// This deliberately does not depend on the query data. The whole point of
	// returning a refusal as data is that the user can leave the message on
	// screen, go and add `workflow_dispatch:` to their workflow, and come back to
	// it. Clearing on every refetch would delete the instructions the moment
	// window focus returned — exactly when they came back to read them.
	useEffect(() => {
		if (open) {
			setOutcome(null);
		}
	}, [open]);

	// Settle on a source once the list arrives. A project with one connected repo
	// — the common case — never sees the picker. Keyed on the query data rather
	// than the `?? []` fallback, which is a fresh array on every render while the
	// query is still in flight.
	useEffect(() => {
		if (!open) {
			return;
		}
		const loaded = sourcesQuery.data ?? [];
		setIntegrationId((current) =>
			current && loaded.some((s) => s.integrationId === current)
				? current
				: (loaded[0]?.integrationId ?? null),
		);
	}, [open, sourcesQuery.data]);

	// Prime the pipeline and ref ONCE per selected repo.
	//
	// Keying this on the `source` OBJECT would re-run on every background refetch
	// — react-query hands back a fresh array identity each time, and it refetches
	// on window focus by default — so alt-tabbing away and back would silently
	// overwrite a branch the user had typed. Keying on the id makes "the selection
	// moved" the only thing that reprimes.
	const primedFor = useRef<string | null>(null);
	useEffect(() => {
		if (!open) {
			// Re-prime next time it opens.
			primedFor.current = null;
			return;
		}
		if (!source || primedFor.current === source.integrationId) {
			return;
		}
		primedFor.current = source.integrationId;
		// Deliberately NOT pre-selected, and not "unless there is only one".
		//
		// The list is every workflow the repository will start on request, which
		// in a real repository includes deploys, releases and cleanup jobs
		// alongside the test ones. Whatever sorts first is arbitrary, so a
		// pre-filled pipeline arms the primary button with a choice nobody made
		// — and "there was only one" is exactly how somebody dispatches without
		// reading. Fabric cannot tell which of a customer's workflows is safe,
		// so it asks rather than guesses; `canRun` already requires a pipeline,
		// so leaving this null is what keeps the button disabled.
		setPipelineId(null);
		setRef(source.defaultRef);
	}, [open, source]);

	/**
	 * Any edit invalidates the previous attempt's verdict. Leaving a green "Run
	 * started" panel sitting above a form the user has since changed reads as
	 * confirmation of a run that was never started.
	 */
	const clearOutcome = () => setOutcome(null);

	const triggerMutation = useMutation(
		orpc.projects.pipelineResults.trigger.mutationOptions({
			onSuccess: (result) => {
				setOutcome(result as TriggerOutcome);
				if (!result.ok) {
					return;
				}
				onTriggered();
				for (const key of [
					orpc.projects.pipelineResults.listRuns.key(),
					orpc.projects.pipelineResults.syncStates.key(),
				]) {
					queryClient.invalidateQueries({ queryKey: key });
				}
			},
			// A thrown error is a Fabric-side fault (repo not connected, no
			// credential); provider refusals come back as a returned outcome.
			onError: (error) =>
				setOutcome({
					ok: false,
					failure: "REQUEST_FAILED",
					message: error.message,
				}),
		}),
	);

	const needsPipeline = source?.kind === "definition";
	/**
	 * Freeze the form while a trigger is in flight.
	 *
	 * Gating only the Start button is not enough: changing the repo mid-request
	 * reprimes the visible fields, so when the original answer lands it renders
	 * under a selection it was never about — the user reads "run started" as
	 * belonging to the repo now on screen.
	 */
	const isSubmitting = triggerMutation.isPending;
	// Mirrors the server's `refSchema` — min 1, max 255, no whitespace, no `..` —
	// so an invalid ref is refused inline instead of after a round trip that
	// reports it as a provider problem. Both sides judge the TRIMMED value,
	// because that is what gets sent.
	const trimmedRef = ref.trim();
	const refIsValid =
		trimmedRef.length > 0 &&
		trimmedRef.length <= 255 &&
		!/\s|\.\./.test(trimmedRef);
	const canRun =
		source !== null &&
		source.kind !== "unsupported" &&
		source.error === null &&
		refIsValid &&
		(!needsPipeline || pipelineId !== null) &&
		!isSubmitting;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>{t("title")}</DialogTitle>
					<DialogDescription>{t("description")}</DialogDescription>
				</DialogHeader>

				{sourcesQuery.isLoading ? (
					<div className="flex items-center gap-2 py-6 text-muted-foreground text-sm">
						<Loader2Icon
							className="size-4 motion-safe:animate-spin"
							aria-hidden="true"
						/>
						{t("loading")}
					</div>
				) : sources.length === 0 ? (
					<p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-6 text-center text-muted-foreground text-sm">
						{t("noSources")}
					</p>
				) : (
					<div className="space-y-4">
						{sources.length > 1 && (
							<div className="space-y-1.5">
								<Label htmlFor="trigger-source">
									{t("sourceLabel")}
								</Label>
								<Select
									value={integrationId ?? undefined}
									onValueChange={(value) => {
										clearOutcome();
										setIntegrationId(value);
									}}
								>
									<SelectTrigger
										id="trigger-source"
										disabled={isSubmitting}
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{sources.map((s) => (
											<SelectItem
												key={s.integrationId}
												value={s.integrationId}
											>
												{s.owner}/{s.repo}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
						)}

						{/* A source Fabric cannot start a run in at all, or whose
						 * credential failed while listing. Either way the remedy is
						 * outside this dialog, so it replaces the form. */}
						{source &&
						(source.kind === "unsupported" || source.error) ? (
							<Alert variant="warning">
								<TriangleAlertIcon aria-hidden="true" />
								<AlertDescription>
									{source.error ?? t("unsupported")}
								</AlertDescription>
							</Alert>
						) : (
							<>
								{needsPipeline &&
									(source.pipelines.length === 0 ? (
										<Alert variant="warning">
											<TriangleAlertIcon aria-hidden="true" />
											<AlertDescription>
												{t("noPipelines")}
											</AlertDescription>
										</Alert>
									) : (
										<div className="space-y-1.5">
											<Label htmlFor="trigger-pipeline">
												{t("pipelineLabel")}
											</Label>
											<Select
												value={pipelineId ?? undefined}
												onValueChange={(value) => {
													clearOutcome();
													setPipelineId(value);
												}}
											>
												<SelectTrigger
													id="trigger-pipeline"
													disabled={isSubmitting}
												>
													<SelectValue
														placeholder={t(
															"pipelinePlaceholder",
														)}
													/>
												</SelectTrigger>
												<SelectContent>
													{source.pipelines.map(
														(p) => (
															<SelectItem
																key={p.id}
																value={p.id}
															>
																{p.name}
															</SelectItem>
														),
													)}
												</SelectContent>
											</Select>
										</div>
									))}

								<div className="space-y-1.5">
									<Label htmlFor="trigger-ref">
										{t("refLabel")}
									</Label>
									<Input
										id="trigger-ref"
										value={ref}
										disabled={isSubmitting}
										aria-invalid={
											ref.length > 0 && !refIsValid
										}
										onChange={(e) => {
											clearOutcome();
											setRef(e.target.value);
										}}
										placeholder={
											source?.defaultRef ?? "main"
										}
									/>
									<p className="text-muted-foreground text-xs">
										{t("refHint")}
									</p>
								</div>
							</>
						)}

						{outcome?.ok === false && (
							<Alert variant="error">
								<TriangleAlertIcon aria-hidden="true" />
								<AlertTitle>{t("failedTitle")}</AlertTitle>
								<AlertDescription>
									{outcome.message}
								</AlertDescription>
							</Alert>
						)}

						{outcome?.ok === true && (
							<Alert variant="success">
								<CircleCheckIcon aria-hidden="true" />
								<AlertTitle>{t("startedTitle")}</AlertTitle>
								<AlertDescription className="space-y-2">
									<span>{t("startedBody")}</span>
									{outcome.runUrl && (
										<a
											href={outcome.runUrl}
											target="_blank"
											rel="noreferrer"
											className="inline-flex items-center gap-1 underline underline-offset-2"
										>
											{t("watchRun")}
											<ExternalLinkIcon
												className="size-3.5"
												aria-hidden="true"
											/>
										</a>
									)}
								</AlertDescription>
							</Alert>
						)}
					</div>
				)}

				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={() => onOpenChange(false)}
					>
						{t("close")}
					</Button>
					<Button
						type="button"
						disabled={!canRun}
						onClick={() => {
							// Re-read rather than coalescing a null id to "" at the
							// call site: an empty integrationId would 404 server-side
							// with a message about the wrong thing entirely.
							if (!source) {
								return;
							}
							triggerMutation.mutate({
								projectId,
								integrationId: source.integrationId,
								ref: trimmedRef,
								...(needsPipeline && pipelineId
									? { pipelineId }
									: {}),
							});
						}}
						className="gap-1.5"
					>
						{triggerMutation.isPending ? (
							<Loader2Icon
								className="size-4 motion-safe:animate-spin"
								aria-hidden="true"
							/>
						) : (
							<PlayIcon className="size-4" aria-hidden="true" />
						)}
						{t("start")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
