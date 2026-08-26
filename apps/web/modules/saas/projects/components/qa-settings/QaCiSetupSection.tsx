"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	CheckIcon,
	CopyIcon,
	Loader2Icon,
	TriangleAlertIcon,
} from "lucide-react";
import { useState } from "react";
import { useDebounceValue } from "usehooks-ts";
import { PipelineProviderIcon } from "../test-cases/pipeline/PipelineProviderIcon";

/** The providers `buildCiConfigTemplate` can produce a snippet for. */
const PROVIDERS = [
	{ value: "GITHUB", label: "GitHub Actions", tag: "github-actions" },
	{ value: "GITLAB", label: "GitLab CI", tag: "gitlab-ci" },
	{ value: "AZURE_DEVOPS", label: "Azure DevOps", tag: "azure-devops" },
] as const;

type Provider = (typeof PROVIDERS)[number]["value"];

/**
 * Settings ▸ Testing — the CI configuration that makes a pipeline report back.
 *
 * Fabric can only read results a pipeline actually publishes, and the commonest
 * reason a sync returns nothing is that the customer's suite never wrote JUnit
 * XML in the first place. The generator for this snippet has existed since card
 * 1688 with no way to reach it, so the answer to "why is my QA tab empty" lived
 * only in our docs.
 *
 * It hands over **text to copy**. Fabric does not write into a customer's
 * repository — that is their infrastructure, the change belongs in their review
 * process, and a tool that silently commits CI config is a tool nobody should
 * trust with a repo token. The copy on this panel says so, so nobody goes looking
 * for an "apply for me" button that will never exist.
 */
export function QaCiSetupSection({ projectId }: { projectId: string }) {
	const [provider, setProvider] = useState<Provider>("GITHUB");
	const [branch, setBranch] = useState("");
	const [testCommand, setTestCommand] = useState("");
	const [junitPath, setJunitPath] = useState("");
	const [copied, setCopied] = useState(false);

	// Debounced before they reach the query. The generator itself is a pure
	// string builder, but the procedure around it is not free: the permission
	// middleware runs two real queries per call, so an un-debounced field spends
	// a round trip and two DB reads on every keystroke of a branch name.
	const [debouncedBranch] = useDebounceValue(branch, 300);
	const [debouncedTestCommand] = useDebounceValue(testCommand, 300);
	const [debouncedJunitPath] = useDebounceValue(junitPath, 300);

	const query = useQuery(
		orpc.projects.pipelineResults.ciConfigTemplate.queryOptions({
			input: {
				projectId,
				provider,
				// Blank means "use the generator's default", which it documents
				// in the snippet itself. Sending "" would override the default
				// with nothing.
				...(debouncedBranch.trim()
					? { branch: debouncedBranch.trim() }
					: {}),
				...(debouncedTestCommand.trim()
					? { testCommand: debouncedTestCommand.trim() }
					: {}),
				...(debouncedJunitPath.trim()
					? { junitPath: debouncedJunitPath.trim() }
					: {}),
			},
		}),
	);

	const template = query.data;

	async function copy() {
		if (!template) {
			return;
		}
		try {
			await navigator.clipboard.writeText(template.content);
			setCopied(true);
			window.setTimeout(() => setCopied(false), 2000);
		} catch {
			// A clipboard permission denial is not worth a toast: the snippet is
			// on screen and selectable, so the user can still get it.
			setCopied(false);
		}
	}

	return (
		<section className="space-y-3">
			<div>
				{/* A heading, not a <Label>: it labels no control, and a
				    screen-reader user navigating by heading would not find this
				    section at all. Matches the sibling environments panel. */}
				<h4 className="font-medium text-sm">
					Make your pipeline report to Fabric
				</h4>
				<p className="mt-1 text-muted-foreground text-xs">
					Fabric reads the test results your pipeline publishes — it
					cannot run your suite or change your CI. Commit this
					yourself; Fabric never writes to your repository.
				</p>
			</div>

			{/* A real <fieldset>, not a div with role="group": the semantics are
			    free here. (The one place this repo uses role="group" instead is a
			    modal where a fieldset could not be height-bounded — not the case
			    on a settings page.) */}
			<fieldset className="flex flex-wrap gap-1.5">
				<legend className="sr-only">CI provider</legend>
				{PROVIDERS.map((p) => (
					<Button
						key={p.value}
						type="button"
						size="sm"
						variant={provider === p.value ? "secondary" : "outline"}
						aria-pressed={provider === p.value}
						onClick={() => setProvider(p.value)}
						className="gap-1.5"
					>
						<PipelineProviderIcon
							provider={p.tag}
							className="size-3.5"
						/>
						{p.label}
					</Button>
				))}
			</fieldset>

			<div className="grid gap-3 sm:grid-cols-3">
				<div className="space-y-1">
					<Label htmlFor="ci-branch" className="text-xs">
						Branch
					</Label>
					<Input
						id="ci-branch"
						value={branch}
						onChange={(e) => setBranch(e.target.value)}
						placeholder="main"
						className="h-8 text-xs"
					/>
				</div>
				<div className="space-y-1">
					<Label htmlFor="ci-test-command" className="text-xs">
						Test command
					</Label>
					<Input
						id="ci-test-command"
						value={testCommand}
						onChange={(e) => setTestCommand(e.target.value)}
						placeholder="npm test -- --reporter=junit"
						className="h-8 text-xs"
					/>
				</div>
				<div className="space-y-1">
					<Label htmlFor="ci-junit-path" className="text-xs">
						JUnit XML path
					</Label>
					<Input
						id="ci-junit-path"
						value={junitPath}
						onChange={(e) => setJunitPath(e.target.value)}
						placeholder="reports/junit.xml"
						className="h-8 text-xs"
					/>
				</div>
			</div>

			{query.isError ? (
				<p className="flex items-center gap-1.5 text-destructive text-sm">
					<TriangleAlertIcon
						className="size-3.5"
						aria-hidden="true"
					/>
					Couldn't build the configuration snippet.
				</p>
			) : query.isLoading || !template ? (
				<p className="flex items-center gap-2 py-3 text-muted-foreground text-sm">
					<Loader2Icon
						className="size-4 motion-safe:animate-spin"
						aria-hidden="true"
					/>
					Building the snippet…
				</p>
			) : (
				<>
					<div className="flex items-center justify-between gap-2">
						<code className="truncate font-mono text-muted-foreground text-xs">
							{template.path}
						</code>
						<Button
							type="button"
							size="sm"
							variant="outline"
							onClick={copy}
							className="shrink-0 gap-1.5"
						>
							{copied ? (
								<CheckIcon
									className="size-3.5"
									aria-hidden="true"
								/>
							) : (
								<CopyIcon
									className="size-3.5"
									aria-hidden="true"
								/>
							)}
							{copied ? "Copied" : "Copy"}
						</Button>
						{/* The button changing its own label is not an
						    announcement. */}
						<output aria-live="polite" className="sr-only">
							{copied ? "Snippet copied to clipboard" : ""}
						</output>
					</div>
					{/* Deliberately NOT height-capped. A capped scroll container
					    hides the tail of the file from anyone who cannot use a
					    mouse wheel, and making it keyboard-operable means a
					    focusable non-interactive element — an unlabelled tab
					    stop. A workflow file is a few dozen lines and the
					    settings page already scrolls, so the constraint bought
					    nothing and cost the accessible answer. */}
					<pre className="overflow-x-auto whitespace-pre rounded-md border border-border bg-muted/60 p-3 font-mono text-[11px] leading-relaxed">
						{template.content}
					</pre>
					{template.notes.length > 0 && (
						<div className="rounded-md border border-dashed border-border px-3 py-2">
							<p className="font-medium text-[11px] text-muted-foreground uppercase tracking-[0.14em]">
								Still yours to do
							</p>
							<ul className="mt-1 list-disc space-y-0.5 pl-4 text-foreground/80 text-xs">
								{template.notes.map((note) => (
									<li key={note}>{note}</li>
								))}
							</ul>
						</div>
					)}
				</>
			)}
		</section>
	);
}
