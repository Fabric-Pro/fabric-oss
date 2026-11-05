"use client";

import {
	type AgentTestCaseSummary,
	agentTestChecksSchema,
} from "@repo/temporal/agent-test-contracts";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription } from "@ui/components/alert";
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
import { Textarea } from "@ui/components/textarea";
import { useId, useState } from "react";
import { toast } from "sonner";

export function agentTestError(error: unknown) {
	if (
		error instanceof Error &&
		"code" in error &&
		[
			"BAD_REQUEST",
			"FORBIDDEN",
			"NOT_FOUND",
			"CONFLICT",
			"SERVICE_UNAVAILABLE",
		].includes(String(error.code))
	) {
		return error.message;
	}
	return "We could not confirm this request. Refresh to check your access and try again.";
}
export function AgentTestCaseDialog({
	organizationId,
	instanceId,
	initialInput = "",
	sourcePreview,
	testCase,
	onClose,
	onSaved,
}: {
	organizationId: string;
	instanceId: string;
	initialInput?: string;
	sourcePreview?: { workflowId: string; runId?: string };
	testCase?: AgentTestCaseSummary;
	onClose: () => void;
	onSaved?: () => void;
}) {
	const id = useId();
	const cache = useQueryClient();
	const [name, setName] = useState(testCase?.name ?? "");
	const [input, setInput] = useState(testCase?.input ?? initialInput);
	const [required, setRequired] = useState(
		testCase?.checks.requiredPhrases.join("\n") ?? "",
	);
	const [forbidden, setForbidden] = useState(
		testCase?.checks.forbiddenPhrases.join("\n") ?? "",
	);
	const checks = agentTestChecksSchema.safeParse({
		requiredPhrases: required
			.split("\n")
			.map((s) => s.trim())
			.filter(Boolean),
		forbiddenPhrases: forbidden
			.split("\n")
			.map((s) => s.trim())
			.filter(Boolean),
	});
	const save = useMutation({
		mutationFn: async () => {
			if (!checks.success) {
				throw new Error("Add an exact text check.");
			}
			const values = {
				name: name.trim(),
				input: input.trim(),
				checks: checks.data,
			};
			return testCase
				? orpcClient.agents.tests.cases.update({
						organizationId,
						caseId: testCase.id,
						revision: testCase.revision,
						...values,
					})
				: orpcClient.agents.tests.cases.create({
						organizationId,
						instanceId,
						sourcePreview,
						...values,
					});
		},
		onSuccess: async () => {
			await cache.invalidateQueries({
				queryKey: ["agent-tests", organizationId],
			});
			toast.success(
				testCase
					? "Test updated"
					: "Test saved. Find it in Insights → Your tests.",
			);
			onSaved?.();
			onClose();
		},
		retry: false,
	});
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !save.isPending) {
					onClose();
				}
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						{testCase ? "Edit test" : "Save as test"}
					</DialogTitle>
					<DialogDescription>
						Save the task and checks to repeat against a saved agent
						version. Draft configuration and preview answers are not
						saved in the test.
					</DialogDescription>
				</DialogHeader>
				<form
					className="space-y-4"
					onSubmit={(event) => {
						event.preventDefault();
						if (checks.success && name.trim() && input.trim()) {
							save.mutate();
						}
					}}
				>
					<div className="space-y-2">
						<Label htmlFor={`${id}-name`}>Test name</Label>
						<Input
							id={`${id}-name`}
							value={name}
							onChange={(e) => setName(e.target.value)}
							maxLength={120}
							required
							placeholder="Weekly report cites its sources"
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor={`${id}-task`}>Task for a new run</Label>
						<Textarea
							id={`${id}-task`}
							value={input}
							onChange={(e) => setInput(e.target.value)}
							maxLength={20000}
							rows={4}
							required
						/>
						<p className="text-xs text-muted-foreground">
							Each test starts a new run. Include any earlier
							conversation context it needs.
						</p>
					</div>
					<div className="space-y-2">
						<Label htmlFor={`${id}-required`}>Must include</Label>
						<Textarea
							id={`${id}-required`}
							value={required}
							onChange={(e) => setRequired(e.target.value)}
							rows={3}
							placeholder="One exact phrase per line"
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor={`${id}-forbidden`}>
							Must not include
						</Label>
						<Textarea
							id={`${id}-forbidden`}
							value={forbidden}
							onChange={(e) => setForbidden(e.target.value)}
							rows={2}
							placeholder="One exact phrase per line"
						/>
						<p className="text-xs text-muted-foreground">
							Case-sensitive text checks. Up to 20 phrases per
							field, 512 characters each. These checks do not
							establish factual accuracy.
						</p>
					</div>
					{!checks.success &&
						(required.trim() || forbidden.trim()) && (
							<output className="block text-sm text-destructive">
								Use at most 20 phrases per field, each under 513
								characters.
							</output>
						)}
					{save.isError && (
						<Alert variant="error">
							<AlertDescription>
								{agentTestError(save.error)}
							</AlertDescription>
						</Alert>
					)}
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							disabled={save.isPending}
							onClick={onClose}
						>
							Cancel
						</Button>
						<Button
							type="submit"
							loading={save.isPending}
							disabled={
								!name.trim() ||
								!input.trim() ||
								!checks.success ||
								save.isPending
							}
						>
							Save test
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
