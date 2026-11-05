"use client";
import type {
	PromptResponseContract,
	PromptResponseValidation,
} from "@repo/ai/lib/prompt-response-contract";
import { DEFAULT_PROMPT_RESPONSE } from "@repo/ai/lib/prompt-response-contract";
import type { PromptWorkbenchDraft } from "@repo/ai/lib/prompt-workbench-contracts";
import { orpcClient } from "@shared/lib/orpc-client";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { Markdown } from "@ui/components/markdown";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { Textarea } from "@ui/components/textarea";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { PromptResponseSettings } from "./PromptResponseSettings";

type Proposal = { message: string; proposal: PromptWorkbenchDraft | null };
function safeError(error: unknown) {
	return error instanceof Error &&
		"code" in error &&
		["FORBIDDEN", "BAD_REQUEST", "SERVICE_UNAVAILABLE"].includes(
			String(error.code),
		)
		? error.message
		: "This request could not finish. Check your AI connection and try again. Your draft is preserved.";
}
export function PromptWorkbenchTabs({ className }: { className?: string }) {
	return (
		<TabsList
			aria-label="Prompt workbench"
			className={`w-full shrink-0 justify-start rounded-none border-b border-border bg-background ${className ?? ""}`}
		>
			<TabsTrigger className="h-full px-5" value="assistant">
				Assistant
			</TabsTrigger>
			<TabsTrigger className="h-full px-5" value="try">
				Try prompt
			</TabsTrigger>
		</TabsList>
	);
}
export function PromptWorkbenchPanel({
	draft,
	organizationId,
	onApply,
	initialTab = "assistant",
	embedded = false,
	activeTab,
	onResponseChange,
	onConfigurationError,
	responseContractError,
}: {
	draft: PromptWorkbenchDraft;
	organizationId: string;
	onApply: (proposal: PromptWorkbenchDraft) => void;
	initialTab?: "assistant" | "try";
	embedded?: boolean;
	activeTab?: "assistant" | "try";
	onResponseChange?: (contract: PromptResponseContract) => void;
	onConfigurationError?: (message: string | undefined) => void;
	responseContractError?: string;
}) {
	const [localContract, setLocalContract] = useState<
		PromptResponseContract | undefined
	>(draft.responseContract);
	const [configurationError, setConfigurationError] = useState<string>();
	const responseContract = onResponseChange
		? draft.responseContract
		: localContract;
	const currentDraft = responseContract
		? { ...draft, responseContract }
		: draft;
	const t = useTranslations("prompts.workbench");
	const responseT = useTranslations("prompts.response");
	const [message, setMessage] = useState("");
	const [history, setHistory] = useState<
		Array<{ role: "user" | "assistant"; content: string }>
	>([]);
	const [proposal, setProposal] = useState<{
		result: Proposal;
		fingerprint: string;
	} | null>(null);
	const [variables, setVariables] = useState("{}");
	const [preview, setPreview] = useState<{
		output: string;
		renderedPrompt: string;
		fingerprint: string;
		responseFormat?: string;
		validation?: PromptResponseValidation;
	} | null>(null);
	const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
		"idle",
	);
	const [busy, setBusy] = useState<"assistant" | "try" | null>(null);
	const [error, setError] = useState<string>();
	const inFlight = useRef(false);
	useEffect(() => {
		if (activeTab) {
			setError(undefined);
		}
	}, [activeTab]);
	const fingerprint = JSON.stringify(currentDraft);
	const previewFingerprint = JSON.stringify({
		draft: currentDraft,
		variables,
	});
	const inputNames =
		draft.format === "PLAIN_TEXT" || draft.format === "MARKDOWN"
			? []
			: [
					...new Set(
						[
							...draft.content.matchAll(
								/\{\{\{?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}\}?/g,
							),
						].map((match) => match[1]),
					),
				];
	const values = (() => {
		try {
			const parsed = JSON.parse(variables);
			return parsed &&
				typeof parsed === "object" &&
				!Array.isArray(parsed)
				? parsed
				: {};
		} catch {
			return {};
		}
	})();

	async function assist() {
		if (inFlight.current || !message.trim()) {
			return;
		}
		inFlight.current = true;
		setBusy("assistant");
		setError(undefined);
		setProposal(null);
		const sent = message.trim();
		const captured = fingerprint;
		try {
			const result = await orpcClient.prompts.assist({
				organizationId,
				draft: currentDraft,
				message: sent,
				history: history.slice(-8),
			});
			setHistory((h) => [
				...h.slice(-6),
				{ role: "user", content: sent },
				{ role: "assistant", content: result.message },
			]);
			setProposal({ result, fingerprint: captured });
			setMessage("");
		} catch (e) {
			setError(safeError(e));
		} finally {
			inFlight.current = false;
			setBusy(null);
		}
	}
	async function run() {
		if (inFlight.current) {
			return;
		}
		setError(undefined);
		let values: Record<string, string>;
		try {
			values = JSON.parse(variables);
			if (
				!values ||
				Array.isArray(values) ||
				typeof values !== "object" ||
				Object.values(values).some((v) => typeof v !== "string")
			) {
				throw new Error();
			}
		} catch {
			setError(
				'Inputs must be a JSON object of text values, for example {"topic":"Release progress"}.',
			);
			return;
		}
		inFlight.current = true;
		setBusy("try");
		setPreview(null);
		setCopyState("idle");
		const captured = previewFingerprint;
		try {
			const result = await orpcClient.prompts.preview({
				organizationId,
				draft: currentDraft,
				variables: values,
			});
			setPreview({
				output: result.output,
				renderedPrompt: result.renderedPrompt,
				responseFormat: result.responseFormat,
				validation: result.validation,
				fingerprint: captured,
			});
		} catch (e) {
			setError(safeError(e));
		} finally {
			inFlight.current = false;
			setBusy(null);
		}
	}
	const panels = (
		<>
			{error && (
				<p role="alert" className="m-4 text-sm text-destructive">
					{error}
				</p>
			)}
			<TabsContent
				value="assistant"
				className="m-0 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
			>
				<div className="min-h-0 flex-1 space-y-5 overflow-auto p-5">
					<p className="text-sm leading-6">
						What would you like this prompt to do? I can help
						clarify its instructions, inputs and expected result.
					</p>
					<p className="text-xs text-muted-foreground">
						Changes are proposals. Review them before applying to
						your draft.
					</p>
					{history.map((entry, i) => (
						<div key={`${i}-${entry.role}`} className="space-y-1">
							<p className="text-xs font-medium text-muted-foreground">
								{entry.role === "user" ? "You" : "Assistant"}
							</p>
							<p className="whitespace-pre-wrap break-words text-sm leading-6">
								{entry.content}
							</p>
						</div>
					))}
					{proposal?.result.proposal && (
						<section
							aria-label="Proposed prompt"
							className="space-y-3 border-t border-border pt-4"
						>
							<h3 className="font-semibold">
								{proposal.result.proposal.name}
							</h3>
							<p className="text-sm text-muted-foreground">
								{proposal.result.proposal.description}
							</p>
							<p className="text-xs text-muted-foreground">
								Format: {proposal.result.proposal.format}
							</p>
							<pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/30 p-3 text-sm">
								{proposal.result.proposal.content}
							</pre>
							{proposal.fingerprint !== fingerprint ? (
								<output className="text-sm text-muted-foreground">
									Your draft changed. Ask for a new proposal
									before applying.
								</output>
							) : (
								<Button
									type="button"
									disabled={!!busy}
									onClick={() => {
										if (
											proposal.fingerprint ===
												JSON.stringify(currentDraft) &&
											proposal.result.proposal
										) {
											onApply(proposal.result.proposal);
											setProposal(null);
										}
									}}
								>
									Apply proposal to draft
								</Button>
							)}
						</section>
					)}
				</div>
				<div className="shrink-0 space-y-2 border-t border-border bg-background p-4">
					<Label htmlFor="prompt-assistant-message">
						Ask the prompt assistant
					</Label>
					<Textarea
						id="prompt-assistant-message"
						value={message}
						maxLength={8000}
						onChange={(e) => setMessage(e.target.value)}
						placeholder="Help me write a weekly delivery summary…"
						className="min-h-24"
					/>
					<Button
						type="button"
						disabled={!!busy || !message.trim()}
						onClick={assist}
					>
						{busy === "assistant"
							? "Preparing proposal…"
							: "Send request"}
					</Button>
				</div>
			</TabsContent>
			<TabsContent
				value="try"
				forceMount
				className="m-0 min-h-0 flex-1 space-y-4 overflow-auto p-5 data-[state=inactive]:hidden"
			>
				<h2 className="font-semibold">Try the current draft</h2>
				<p className="text-sm text-muted-foreground">{t("purpose")}</p>

				{inputNames.length > 0 && (
					<div className="space-y-3">
						{inputNames.map((name, index) => (
							<div key={name} className="space-y-1">
								<Label htmlFor={`prompt-input-${index}`}>
									{name}
								</Label>
								<Input
									id={`prompt-input-${index}`}
									value={
										typeof values[name] === "string"
											? values[name]
											: ""
									}
									onChange={(event) =>
										setVariables(
											JSON.stringify(
												{
													...values,
													[name]: event.target.value,
												},
												null,
												2,
											),
										)
									}
								/>
							</div>
						))}
					</div>
				)}
				<p className="text-xs text-muted-foreground">
					Plain text and Markdown are sent verbatim. Other formats
					support text placeholders such as {"{{topic}}"} in this
					preview. Template logic and filters are not executed here.
				</p>
				<details>
					<summary className="cursor-pointer text-sm">
						Advanced inputs
					</summary>
					<Label htmlFor="prompt-try-inputs">
						Template inputs (JSON)
					</Label>
					<Textarea
						id="prompt-try-inputs"
						value={variables}
						onChange={(e) => setVariables(e.target.value)}
						className="mt-2 min-h-28 font-mono"
					/>
				</details>

				{responseContractError ? (
					<p role="alert" className="text-sm text-destructive">
						{responseContractError}
					</p>
				) : (
					<PromptResponseSettings
						value={responseContract ?? DEFAULT_PROMPT_RESPONSE}
						onChange={(contract) => {
							setLocalContract(contract);
							onResponseChange?.(contract);
						}}
						onError={(message) => {
							setConfigurationError(message);
							onConfigurationError?.(message);
						}}
					/>
				)}
				<Button
					type="button"
					disabled={
						!!busy ||
						!!configurationError ||
						!!responseContractError ||
						!draft.content.trim()
					}
					onClick={run}
				>
					{busy === "try" ? "Running prompt…" : "Run preview"}
				</Button>
				{preview && (
					<section
						aria-label="Preview result"
						className="space-y-3 border-t border-border pt-4"
					>
						{preview.fingerprint !== previewFingerprint && (
							<output className="text-sm text-muted-foreground">
								Draft or inputs changed. This result belongs to
								the previous preview.
							</output>
						)}
						{preview.validation &&
							preview.validation.status !== "not_requested" && (
								<output
									className={
										preview.validation.status === "passed"
											? "block rounded-md border border-border p-3 text-sm text-success"
											: "block rounded-md border border-border p-3 text-sm text-destructive"
									}
								>
									<span className="block font-medium">
										{preview.validation.status === "passed"
											? preview.responseFormat === "XML"
												? responseT("xmlPassed")
												: responseT("jsonPassed")
											: responseT("failed")}
									</span>
									{preview.validation.issues.map(
										(issue, index) => (
											<span
												className="block"
												key={`${index}-${issue.path}`}
											>
												{issue.path}: {issue.message}
											</span>
										),
									)}
								</output>
							)}
						<div className="flex flex-wrap items-center justify-between gap-2">
							<h3 className="font-semibold">
								{t("modelOutput")}
							</h3>
							<Button
								type="button"
								variant="outline"
								size="sm"
								disabled={!preview.output}
								onClick={async () => {
									try {
										await navigator.clipboard.writeText(
											preview.output,
										);
										setCopyState("copied");
									} catch {
										setCopyState("failed");
									}
								}}
							>
								{copyState === "copied"
									? t("copied")
									: t("copyResult")}
							</Button>
						</div>
						{copyState === "failed" && (
							<output className="block text-sm text-muted-foreground">
								{t("copyFailed")}
							</output>
						)}
						<Tabs defaultValue="formatted" className="min-w-0">
							<TabsList aria-label={t("resultDisplay")}>
								<TabsTrigger value="formatted">
									{t("formatted")}
								</TabsTrigger>
								<TabsTrigger value="raw">
									{t("rawText")}
								</TabsTrigger>
							</TabsList>
							<TabsContent value="formatted" className="min-w-0">
								{["TEXT", "JSON", "XML"].includes(
									preview.responseFormat ?? "",
								) ? (
									<pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted p-3 text-sm [overflow-wrap:anywhere]">
										<code>
											{preview.output || t("emptyOutput")}
										</code>
									</pre>
								) : (
									<Markdown
										className="min-w-0 overflow-x-auto break-words [overflow-wrap:anywhere]"
										components={{
											// Text previews never fetch image URLs from an untrusted model response.
											img: ({ alt }) => (
												<span>
													{alt
														? `[Image: ${alt}]`
														: "[Image]"}
												</span>
											),
											a: ({ children, href, title }) => (
												<a
													href={href}
													title={title}
													target="_blank"
													rel="noopener noreferrer"
												>
													{children}
												</a>
											),
										}}
									>
										{preview.output || t("emptyOutput")}
									</Markdown>
								)}
							</TabsContent>
							<TabsContent value="raw">
								<pre className="overflow-x-auto whitespace-pre-wrap break-words text-sm leading-6 [overflow-wrap:anywhere]">
									{preview.output || t("emptyOutput")}
								</pre>
							</TabsContent>
						</Tabs>
						<details>
							<summary className="cursor-pointer text-sm">
								Rendered input
							</summary>
							<pre className="mt-2 whitespace-pre-wrap break-words text-xs">
								{preview.renderedPrompt}
							</pre>
						</details>
						<p className="text-xs text-muted-foreground">
							{t("singleResponse")}
						</p>
					</section>
				)}
			</TabsContent>
		</>
	);
	if (embedded) {
		return panels;
	}
	return (
		<Tabs
			defaultValue={initialTab}
			className="flex min-h-0 flex-1 flex-col"
			onValueChange={() => setError(undefined)}
		>
			<PromptWorkbenchTabs />
			{panels}
		</Tabs>
	);
}
