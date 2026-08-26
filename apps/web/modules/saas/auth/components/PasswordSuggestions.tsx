interface PasswordSuggestionsProps {
	suggestions: string[];
}

export function PasswordSuggestions({ suggestions }: PasswordSuggestionsProps) {
	if (suggestions.length === 0) {
		return null;
	}
	return (
		<ul
			className="mt-1 list-disc pl-4 text-destructive text-sm"
			role="alert"
		>
			{suggestions.map((s, i) => (
				<li key={i}>{s}</li>
			))}
		</ul>
	);
}
