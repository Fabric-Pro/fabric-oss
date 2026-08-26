import { GitBranchIcon } from "lucide-react";

/** Small muted "on <branch>" tag — a git-branch icon plus the branch name. */
export function ScanBranchTag({ branch }: { branch: string }) {
	return (
		<span className="inline-flex items-center gap-1 text-muted-foreground text-xs">
			<GitBranchIcon aria-hidden="true" className="size-3.5" />
			{branch}
		</span>
	);
}
