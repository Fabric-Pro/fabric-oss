import { FABRIC_IGNORE_FILE, SNAPSHOT_LIMITS } from "@repo/instructions";
import { toast } from "sonner";

export async function copyInstructionText(
	text: string,
	copied: string,
	failed: string,
): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		toast.success(copied);
		return true;
	} catch {
		toast.error(failed);
		return false;
	}
}

export function instructionEditRefusal(
	file: {
		path: string;
		body: string | null;
		size: number;
		truncated: boolean;
	},
	t: (key: string, values?: Record<string, string>) => string,
	replaceAction: string,
	repositoryBacked: boolean,
): string | null {
	if (file.path === FABRIC_IGNORE_FILE)
		return t(
			repositoryBacked
				? "editFabricignoreRepository"
				: "editFabricignore",
		);
	if (file.body === null) return t("editBinary", { action: replaceAction });
	if (file.truncated || file.size > SNAPSHOT_LIMITS.maxInlineTextBytes)
		return t("editTooLarge", { action: replaceAction });
	return null;
}
