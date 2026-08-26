"use client";

/**
 * useCodeContextLauncher - Hook for launching Fabric Agent with code context
 *
 * This hook provides helpers to extract code from selections and open the
 * Fabric Agent launcher with the code context attached.
 *
 * Usage:
 * ```tsx
 * const { openWithSelectedCode, openWithCodeBlock } = useCodeContextLauncher({
 *   projectId,
 *   projectName,
 *   storyId,
 *   storyIdentifier,
 *   storyTitle,
 * });
 *
 * // From text selection
 * const handleSelection = () => {
 *   const selection = window.getSelection()?.toString();
 *   if (selection) {
 *     openWithSelectedCode(selection, "Selected code");
 *   }
 * };
 *
 * // From code block
 * const handleCodeBlock = (code: string, language?: string) => {
 *   openWithCodeBlock(code, language);
 * };
 * ```
 */

import {
	type CodeContext,
	useFabricAgentLauncher,
} from "../components/FabricAgentLauncher";

interface UseCodeContextLauncherOptions {
	projectId?: string | null;
	projectName?: string | null;
	storyId?: string | null;
	storyIdentifier?: string | null;
	storyTitle?: string | null;
	taskId?: string | null;
	taskIdentifier?: string | null;
	taskTitle?: string | null;
	repositoryUrl?: string | null;
	repositoryOwner?: string | null;
	repositoryName?: string | null;
	defaultBranch?: string | null;
}

interface UseCodeContextLauncherReturn {
	/** Open launcher with selected code snippet */
	openWithSelectedCode: (
		code: string,
		fileName?: string,
		prompt?: string,
	) => void;
	/** Open launcher with code block content */
	openWithCodeBlock: (
		code: string,
		language?: string,
		prompt?: string,
	) => void;
	/** Open launcher with full code context */
	openWithCodeContext: (codeContext: CodeContext, prompt?: string) => void;
	/** Extract code from current text selection */
	getSelectedText: () => string | null;
	/** Check if text is likely code */
	isLikelyCode: (text: string) => boolean;
}

/** Check if text looks like code vs natural language */
function isCodeLike(text: string): boolean {
	// Quick heuristics
	const codeIndicators = [
		/{|}/, // Braces
		/\b(function|class|const|let|var|import|export|return|if|for|while)\b/, // Keywords
		/\b(def|class|import|from|return|if|for|while)\b/, // Python
		/\b(func|package|import|return|if|for|range)\b/, // Go
		/[;{}()]+.*[;{}()]+/, // Multiple punctuation
		/^(const|let|var|function|class|interface|type)\s+\w+/m, // Declarations
	];

	const codeScore = codeIndicators.reduce((score, pattern) => {
		return score + (pattern.test(text) ? 1 : 0);
	}, 0);

	// If 2+ indicators match, likely code
	return codeScore >= 2;
}

/** Detect language from code snippet */
function detectLanguage(code: string): string | undefined {
	if (/\bfunc\s+\w+\s*\(/.test(code)) {
		return "go";
	}
	if (/\bdef\s+\w+\s*\(/.test(code)) {
		return "python";
	}
	if (/\b(const|let|var)\s+\w+\s*[:=]/.test(code)) {
		return "javascript";
	}
	if (/\binterface\s+\w+/.test(code)) {
		return "typescript";
	}
	if (/\bclass\s+\w+.*\{/.test(code)) {
		return "typescript";
	}
	if (/</.test(code) && /\/>/.test(code)) {
		return "tsx";
	}
	if (/\bimport\s+\w+\s+from\s+['"]/.test(code)) {
		return "javascript";
	}
	if (/\bfn\s+\w+/.test(code)) {
		return "rust";
	}
	if (/\bpublic\s+(class|void|String)/.test(code)) {
		return "java";
	}
	return undefined;
}

export function useCodeContextLauncher(
	options: UseCodeContextLauncherOptions,
): UseCodeContextLauncherReturn {
	const { openLauncher } = useFabricAgentLauncher();

	const getSelectedText = (): string | null => {
		const selection = window.getSelection();
		if (!selection || selection.rangeCount === 0) {
			return null;
		}
		const text = selection.toString().trim();
		return text.length > 0 ? text : null;
	};

	const isLikelyCode = (text: string): boolean => {
		return isCodeLike(text);
	};

	const openWithCodeContext = (
		codeContext: CodeContext,
		prompt?: string,
	): void => {
		openLauncher({
			projectId: options.projectId,
			projectName: options.projectName,
			storyId: options.storyId,
			storyIdentifier: options.storyIdentifier,
			storyTitle: options.storyTitle,
			taskId: options.taskId,
			taskIdentifier: options.taskIdentifier,
			taskTitle: options.taskTitle,
			repositoryUrl: options.repositoryUrl,
			repositoryOwner: options.repositoryOwner,
			repositoryName: options.repositoryName,
			codeContext: {
				...codeContext,
				branch: codeContext.branch ?? options.defaultBranch,
			},
			prompt:
				prompt ||
				(codeContext.snippet
					? "Explain this code:"
					: "Help with this code"),
		});
	};

	const openWithSelectedCode = (
		code: string,
		fileName?: string,
		prompt?: string,
	): void => {
		const _language = detectLanguage(code);

		openWithCodeContext(
			{
				filePath: fileName,
				snippet: code,
				// Extract line numbers if in format "file:line" or similar
			},
			prompt,
		);
	};

	const openWithCodeBlock = (
		code: string,
		language?: string,
		prompt?: string,
	): void => {
		const detectedLang = language || detectLanguage(code);

		openWithCodeContext(
			{
				snippet: code,
				// Language hint could be useful for the agent
			},
			prompt || `Explain this ${detectedLang || "code"}:`,
		);
	};

	return {
		openWithSelectedCode,
		openWithCodeBlock,
		openWithCodeContext,
		getSelectedText,
		isLikelyCode,
	};
}
