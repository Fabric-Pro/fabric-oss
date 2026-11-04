"use client";

import { Loader2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import {
	type ContextFolderPolicy,
	contextIgnorePathOf,
} from "./lib/context-selection";

const NAMESPACE = "projects.contexts.livingMemory.repositorySync.tree.notices";

/**
 * What applies to each ticked folder's `.contextignore` as a whole, above
 * Living Memory's tree: the files being read, each file whose rules leave
 * something out, each the run cannot evaluate (it then leaves that folder's
 * files as they are), each with a rule the run refuses (every sync fails),
 * and each that could not be read here. Each row it affects says so in a
 * few words; this is the whole story, as Coding Instructions' notices tell
 * it for a `.fabricignore`.
 */
export function ContextIgnoreNotices({
	policies,
}: {
	policies: ReadonlyMap<string, ContextFolderPolicy>;
}) {
	const t = useTranslations(NAMESPACE);
	const entries = [...policies]
		.filter(([, policy]) => policy.kind !== "defaults")
		.sort(([a], [b]) => a.localeCompare(b));
	const loading = entries.some(([, policy]) => policy.kind === "loading");
	return (
		<>
			{loading ? (
				<output className="flex items-center gap-2 text-muted-foreground text-xs">
					<Loader2Icon
						className="size-3 motion-safe:animate-spin"
						aria-hidden="true"
					/>
					{t("loading")}
				</output>
			) : null}
			{entries.map(([folder, policy]) => {
				const file = contextIgnorePathOf(folder);
				switch (policy.kind) {
					case "defaults":
					case "loading":
						return null;
					case "rules":
						return (
							<p key={folder} className="text-xs">
								{t("rules", { file })}
							</p>
						);
					case "unreadable":
						return (
							<p
								key={folder}
								className="text-muted-foreground text-xs"
							>
								{t(`unreadable.${policy.reason}`, { file })}
							</p>
						);
					case "rejected":
						return (
							<p
								key={folder}
								role="alert"
								className="text-destructive text-xs"
							>
								{t("rejected", { file, line: policy.line })}
							</p>
						);
					case "failed":
						return (
							<p
								key={folder}
								role="alert"
								className="text-destructive text-xs"
							>
								{t("failed", { file })}
							</p>
						);
					default: {
						const unreachable: never = policy;
						return unreachable;
					}
				}
			})}
		</>
	);
}
