"use client";

import type { ResultQualityGrade } from "@repo/utils/result-quality";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { Textarea } from "@ui/components/textarea";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";

type Context = {
	workflowId: string;
	organizationId: string;
	executionId: string;
	nodeId: string;
};
const phrases = (value: string) => [
	...new Set(value.split(/\r?\n/).filter((line) => line.trim().length > 0)),
];
function Results({
	expectations,
	quality,
}: {
	quality?: ResultQualityGrade;
	expectations: {
		kind: "required" | "forbidden";
		phrase: string;
		passed: boolean;
	}[];
}) {
	const t = useTranslations("workflows.checks");
	const copy = (key: string, fallback: string) =>
		t.has(key) ? t(key) : fallback;
	if (quality) {
		return (
			<section
				aria-label={copy("checkResults", "Check results")}
				className="space-y-2 rounded-lg border p-3 text-sm"
			>
				<p role="status" className="font-medium">
					{quality.status === "PASSED"
						? copy("passed", "All checks passed")
						: quality.status === "NOT_ASSESSED"
							? "Not assessed"
							: copy("attention", "Needs attention")}{" "}
					· {quality.passed}/{quality.total}
					{quality.unavailable > 0
						? ` · ${quality.unavailable} not assessed`
						: ""}
				</p>
				<ul className="space-y-1">
					{quality.results.map((check) => (
						<li
							key={`${check.kind}-${check.index}`}
							className="break-words"
						>
							{!check.available
								? "Not assessed"
								: check.passed
									? "Passed"
									: "Failed"}{" "}
							·{" "}
							{check.kind === "schema"
								? "JSON schema"
								: check.kind === "json"
									? `JSON value check ${check.index + 1}`
									: check.kind === "grounding"
										? "Grounding evidence (trusted retrieval receipts required)"
										: check.kind === "required"
											? `Required text check ${check.index + 1}`
											: `Forbidden text check ${check.index + 1}`}
						</li>
					))}
				</ul>
			</section>
		);
	}
	const passed = expectations.filter((check) => check.passed).length;
	return (
		<section
			aria-label={copy("checkResults", "Check results")}
			className="space-y-2 rounded-lg border p-3 text-sm"
		>
			<p role="status" className="font-medium">
				{passed === expectations.length
					? copy("passed", "All checks passed")
					: copy("attention", "Needs attention")}{" "}
				· {passed}/{expectations.length}
			</p>
			<ul className="space-y-1">
				{expectations.map((check) => (
					<li
						key={`${check.kind}-${check.phrase}`}
						className="break-words"
					>
						{check.passed ? "✓" : "×"}{" "}
						{check.kind === "required"
							? copy("include", "Must include")
							: copy("exclude", "Must not include")}
						: “{check.phrase}”
					</li>
				))}
			</ul>
		</section>
	);
}
function CheckDialog({
	context,
	onClose,
}: {
	context: Context;
	onClose: () => void;
}) {
	const t = useTranslations("workflows.checks");
	const copy = (key: string, fallback: string) =>
		t.has(key) ? t(key) : fallback;
	const client = useQueryClient();
	const [name, setName] = useState("");
	const [required, setRequired] = useState("");
	const [forbidden, setForbidden] = useState("");
	const [selected, setSelected] = useState("");
	const [removeTarget, setRemoveTarget] = useState<{
		id: string;
		revision: string;
		name: string;
	} | null>(null);
	const org = {
		workflowId: context.workflowId,
		organizationId: context.organizationId,
	};
	const inspect = useQuery(
		orpc.workflows.checks.inspect.queryOptions({
			input: context,
			staleTime: 0,
			gcTime: 0,
			refetchOnWindowFocus: false,
		}),
	);
	const list = useQuery(
		orpc.workflows.checks.list.queryOptions({
			input: org,
			staleTime: 0,
			gcTime: 0,
		}),
	);
	const refresh = () =>
		client.invalidateQueries({
			queryKey: orpc.workflows.checks.list.key(),
		});
	const preview = useMutation(
		orpc.workflows.checks.preview.mutationOptions(),
	);
	const save = useMutation(
		orpc.workflows.checks.save.mutationOptions({
			onSuccess: () => {
				toast.success(
					copy(
						"saved",
						"Check saved. Compare it with future runs from their step results.",
					),
				);
				void refresh();
			},
			onError: (error) => toast.error(error.message),
		}),
	);
	const compare = useMutation(orpc.workflows.checks.apply.mutationOptions());
	const remove = useMutation(
		orpc.workflows.checks.remove.mutationOptions({
			onSuccess: () => {
				setSelected("");
				setRemoveTarget(null);
				compare.reset();
				void refresh();
			},
			onError: (error) => toast.error(error.message),
		}),
	);
	const input = {
		...context,
		expectedRevision: inspect.data?.revision ?? "",
		requiredPhrases: phrases(required),
		forbiddenPhrases: phrases(forbidden),
	};
	const check = list.data?.cases.find((item) => item.id === selected);
	const cases =
		list.data?.cases.filter((item) => item.nodeId === context.nodeId) ?? [];
	useEffect(() => {
		if (
			list.data &&
			!list.data.cases.some(
				(item) =>
					item.id === selected && item.nodeId === context.nodeId,
			)
		) {
			const matches = list.data.cases.filter(
				(item) => item.nodeId === context.nodeId,
			);
			setSelected(matches.length === 1 ? matches[0].id : "");
		}
	}, [list.data, selected, context.nodeId]);
	useEffect(() => {
		if (
			removeTarget &&
			(selected !== removeTarget.id ||
				!list.data?.cases.some(
					(item) =>
						item.id === removeTarget.id &&
						item.revision === removeTarget.revision,
				))
		) {
			setRemoveTarget(null);
		}
	}, [selected, list.data, removeTarget]);
	const invalidPhrases =
		input.requiredPhrases.length > 20 ||
		input.forbiddenPhrases.length > 20 ||
		[...input.requiredPhrases, ...input.forbiddenPhrases].some(
			(phrase) => phrase.length > 512,
		);
	const busy =
		preview.isPending ||
		save.isPending ||
		compare.isPending ||
		remove.isPending;
	const reset = () => {
		preview.reset();
		save.reset();
	};
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) {
					onClose();
				}
			}}
		>
			<DialogContent className="max-w-2xl">
				<DialogHeader>
					<DialogTitle>
						{copy("title", "Check this result")}
					</DialogTitle>
					<DialogDescription>
						{copy(
							"description",
							"Check exact phrases in a completed result. Save a passing baseline to compare future runs and versions.",
						)}
					</DialogDescription>
				</DialogHeader>
				{inspect.isPending || list.isPending ? (
					<p role="status">
						{copy("loading", "Loading recorded result…")}
					</p>
				) : inspect.isError || list.isError ? (
					<div role="alert" className="space-y-2">
						<p>{inspect.error?.message ?? list.error?.message}</p>
						<Button
							variant="outline"
							onClick={() => {
								void inspect.refetch();
								void list.refetch();
							}}
						>
							{copy("retry", "Try again")}
						</Button>
					</div>
				) : (
					<>
						<Tabs defaultValue={cases.length ? "saved" : "new"}>
							<TabsList
								aria-label={copy("checkMode", "Result checks")}
							>
								<TabsTrigger value="new">
									{copy("new", "New check")}
								</TabsTrigger>
								<TabsTrigger value="saved">
									{copy("savedChecks", "Saved checks")}
									{cases.length ? ` · ${cases.length}` : ""}
								</TabsTrigger>
							</TabsList>
							<TabsContent value="new" className="space-y-4">
								<div className="space-y-2">
									<Label htmlFor="result-required">
										{copy(
											"required",
											"Must include — one exact phrase per line",
										)}
									</Label>
									<Textarea
										disabled={save.isPending}
										id="result-required"
										value={required}
										maxLength={10259}
										rows={3}
										onChange={(event) => {
											setRequired(event.target.value);
											reset();
										}}
										placeholder={copy(
											"requiredExample",
											"For example: Next steps",
										)}
									/>
								</div>
								<div className="space-y-2">
									<Label htmlFor="result-forbidden">
										{copy(
											"forbidden",
											"Must not include — one exact phrase per line",
										)}
									</Label>
									<Textarea
										disabled={save.isPending}
										id="result-forbidden"
										value={forbidden}
										maxLength={10259}
										rows={2}
										onChange={(event) => {
											setForbidden(event.target.value);
											reset();
										}}
										placeholder={copy(
											"forbiddenExample",
											"For example: No risks remain",
										)}
									/>
								</div>
								<p className="text-xs text-muted-foreground">
									{copy(
										"limits",
										"Phrases are case-sensitive and spaces count. Add at least one phrase, up to 20 in each field.",
									)}
								</p>
								{invalidPhrases && (
									<p role="alert">
										{copy(
											"phraseLimits",
											"Use up to 20 phrases in each field, each no longer than 512 characters.",
										)}
									</p>
								)}
								<Button
									disabled={
										busy ||
										input.requiredPhrases.length +
											input.forbiddenPhrases.length ===
											0 ||
										invalidPhrases
									}
									onClick={() => preview.mutate(input)}
								>
									{preview.isPending
										? copy("checking", "Checking…")
										: copy(
												"preview",
												"Check recorded result",
											)}
								</Button>
								{preview.isError && (
									<p role="alert">{preview.error.message}</p>
								)}
								{preview.data && (
									<Results
										expectations={preview.data.expectations}
										quality={preview.data.quality}
									/>
								)}
								{preview.data?.report.status === "passed" &&
									list.data?.canManage && (
										<div className="space-y-2 rounded-lg border p-3">
											<Label htmlFor="result-check-name">
												{copy("name", "Check name")}
											</Label>
											<Input
												disabled={save.isPending}
												id="result-check-name"
												value={name}
												maxLength={120}
												placeholder={copy(
													"nameExample",
													"Delivery brief includes next steps",
												)}
												onChange={(event) => {
													setName(event.target.value);
													save.reset();
												}}
											/>
											<Button
												disabled={
													busy ||
													!name.trim() ||
													save.isSuccess
												}
												onClick={() =>
													save.mutate({
														...input,
														name,
													})
												}
											>
												{save.isSuccess
													? copy(
															"savedShort",
															"Saved",
														)
													: save.isPending
														? copy(
																"saving",
																"Saving…",
															)
														: copy(
																"save",
																"Save check",
															)}
											</Button>
										</div>
									)}
							</TabsContent>
							<TabsContent value="saved" className="space-y-4">
								{!cases.length ? (
									<p className="text-sm text-muted-foreground">
										{copy(
											"empty",
											"Save a passing result as a check to compare future runs of this step.",
										)}
									</p>
								) : (
									<>
										<div className="space-y-2">
											<Label htmlFor="saved-result-check">
												{copy(
													"choose",
													"Choose a check",
												)}
											</Label>
											<Select
												value={selected}
												onValueChange={(value) => {
													setSelected(value);
													setRemoveTarget(null);
													compare.reset();
												}}
											>
												<SelectTrigger id="saved-result-check">
													<SelectValue
														placeholder={copy(
															"choose",
															"Choose a check",
														)}
													/>
												</SelectTrigger>
												<SelectContent>
													{cases.map((item) => (
														<SelectItem
															key={item.id}
															value={item.id}
														>
															{item.name}
														</SelectItem>
													))}
												</SelectContent>
											</Select>
										</div>
										{check && (
											<>
												<p className="text-sm text-muted-foreground">
													{copy(
														"baseline",
														"Baseline",
													)}
													: v{check.baselineVersion} ·{" "}
													{check.baselineExecutionId.slice(
														0,
														8,
													)}
												</p>
												<Button
													disabled={busy}
													onClick={() =>
														compare.mutate({
															...org,
															checkId: check.id,
															expectedCaseRevision:
																check.revision,
															executionId:
																context.executionId,
														})
													}
												>
													{compare.isPending
														? copy(
																"checking",
																"Checking…",
															)
														: copy(
																"compare",
																"Compare with baseline",
															)}
												</Button>
												{compare.isError && (
													<p role="alert">
														{compare.error.message}
													</p>
												)}
												{compare.data && (
													<>
														<p className="text-sm">
															v
															{
																compare.data
																	.baseline
																	.version
															}{" "}
															→ v
															{
																compare.data
																	.candidate
																	.version
															}{" "}
															·{" "}
															{compare.data
																.change ===
															"regressed"
																? copy(
																		"regressed",
																		"A previously passing check now fails",
																	)
																: compare.data
																			.change ===
																		"improved"
																	? copy(
																			"improved",
																			"Result improved",
																		)
																	: copy(
																			"unchanged",
																			"Same check outcome",
																		)}
														</p>
														<Results
															quality={
																compare.data
																	.candidate
																	.quality
															}
															expectations={
																compare.data
																	.candidate
																	.expectations
															}
														/>
														{compare.data.candidate
															.report.status ===
															"failed" && (
															<p className="text-sm text-muted-foreground">
																{copy(
																	"improve",
																	"Review the workflow’s instructions or context, run it again, and compare the new result.",
																)}
															</p>
														)}
													</>
												)}
												{list.data?.canManage && (
													<div className="space-y-2 border-t pt-3">
														{removeTarget ? (
															<>
																<p className="text-sm font-medium">
																	{
																		removeTarget.name
																	}
																</p>
																<p className="text-sm">
																	{copy(
																		"removeQuestion",
																		"Remove this saved check? The original run stays available.",
																	)}
																</p>
																<Button
																	variant="destructive"
																	disabled={
																		busy
																	}
																	onClick={() =>
																		remove.mutate(
																			{
																				...org,
																				checkId:
																					removeTarget.id,
																				expectedCaseRevision:
																					removeTarget.revision,
																			},
																		)
																	}
																>
																	{copy(
																		"confirmRemove",
																		"Remove check",
																	)}
																</Button>
																<Button
																	variant="ghost"
																	onClick={() =>
																		setRemoveTarget(
																			null,
																		)
																	}
																>
																	{copy(
																		"cancel",
																		"Cancel",
																	)}
																</Button>
															</>
														) : (
															<Button
																variant="ghost"
																size="sm"
																onClick={() =>
																	setRemoveTarget(
																		{
																			id: check.id,
																			revision:
																				check.revision,
																			name: check.name,
																		},
																	)
																}
															>
																{copy(
																	"remove",
																	"Remove saved check",
																)}
															</Button>
														)}
													</div>
												)}
											</>
										)}
									</>
								)}
							</TabsContent>
						</Tabs>
						<p className="text-xs text-muted-foreground">
							{copy(
								"boundary",
								"These checks verify exact phrases, not factual accuracy or retrieval quality. No workflow, model or external service is invoked.",
							)}
						</p>
					</>
				)}
				<DialogFooter>
					<Button variant="outline" onClick={onClose}>
						{copy("close", "Close")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
export function WorkflowResultChecks(context: Context) {
	const t = useTranslations("workflows.checks");
	const [open, setOpen] = useState(false);
	return (
		<>
			<Button size="sm" variant="outline" onClick={() => setOpen(true)}>
				{t.has("open") ? t("open") : "Check result"}
			</Button>
			{open && (
				<CheckDialog context={context} onClose={() => setOpen(false)} />
			)}
		</>
	);
}
