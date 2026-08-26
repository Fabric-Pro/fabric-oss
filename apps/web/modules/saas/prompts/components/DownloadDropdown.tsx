"use client";

import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { Check, Download, FileCode, FileText, Link } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

interface DownloadDropdownProps {
	promptId: string;
	promptName: string;
	content: string;
	description?: string;
	category?: string;
	tags?: string[];
}

export function DownloadDropdown({
	promptId,
	promptName,
	content,
	description,
	category,
	tags,
}: DownloadDropdownProps) {
	const [copiedFormat, setCopiedFormat] = useState<"md" | "yml" | null>(null);

	const getFileName = (format: "md" | "yml") => {
		const slug = promptName
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/(^-|-$)/g, "");
		return `${slug}.prompt.${format}`;
	};

	const generateMarkdown = () => {
		let md = `# ${promptName}\n\n`;
		if (description) {
			md += `${description}\n\n`;
		}
		if (category) {
			md += `**Category:** ${category}\n\n`;
		}
		if (tags && tags.length > 0) {
			md += `**Tags:** ${tags.join(", ")}\n\n`;
		}
		md += `## Prompt\n\n\`\`\`\n${content}\n\`\`\`\n`;
		return md;
	};

	const generateYaml = () => {
		let yml = `name: "${promptName.replace(/"/g, '\\"')}"\n`;
		if (description) {
			yml += `description: "${description.replace(/"/g, '\\"')}"\n`;
		}
		if (category) {
			yml += `category: "${category}"\n`;
		}
		if (tags && tags.length > 0) {
			yml += `tags:\n${tags.map((t) => `  - "${t}"`).join("\n")}\n`;
		}
		yml += `content: |\n${content
			.split("\n")
			.map((line) => `  ${line}`)
			.join("\n")}\n`;
		return yml;
	};

	const handleDownload = (format: "md" | "yml") => {
		const fileContent =
			format === "md" ? generateMarkdown() : generateYaml();
		const blob = new Blob([fileContent], {
			type: "text/plain;charset=utf-8",
		});
		const downloadUrl = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = downloadUrl;
		a.download = getFileName(format);
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(downloadUrl);
		toast.success("Download started");
	};

	const handleCopyUrl = async (format: "md" | "yml") => {
		const url = `${window.location.origin}/api/prompts/${promptId}/download?format=${format}`;
		try {
			await navigator.clipboard.writeText(url);
			setCopiedFormat(format);
			toast.success("URL copied to clipboard");
			setTimeout(() => setCopiedFormat(null), 2000);
		} catch {
			toast.error("Failed to copy URL");
		}
	};

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="ghost" size="sm">
					<Download className="h-4 w-4" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-48">
				<DropdownMenuItem onClick={() => handleDownload("md")}>
					<FileText className="h-4 w-4 mr-2" />
					Download Markdown
				</DropdownMenuItem>
				<DropdownMenuItem onClick={() => handleDownload("yml")}>
					<FileCode className="h-4 w-4 mr-2" />
					Download YAML
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuItem onClick={() => handleCopyUrl("md")}>
					{copiedFormat === "md" ? (
						<Check className="h-4 w-4 mr-2 text-success" />
					) : (
						<Link className="h-4 w-4 mr-2" />
					)}
					Copy Markdown URL
				</DropdownMenuItem>
				<DropdownMenuItem onClick={() => handleCopyUrl("yml")}>
					{copiedFormat === "yml" ? (
						<Check className="h-4 w-4 mr-2 text-success" />
					) : (
						<Link className="h-4 w-4 mr-2" />
					)}
					Copy YAML URL
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
