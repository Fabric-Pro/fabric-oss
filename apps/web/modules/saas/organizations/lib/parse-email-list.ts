const TOKEN = /"[^"]*"|<[^<>]*>|[^\s,;<>"]+/g;

/**
 * Splits a pasted list into addresses, accepting the separators and the
 * `Name <address>` format mail clients produce, including a quoted name with a
 * comma in it. Words that turn out to be a name are dropped once their address
 * arrives; any left over are kept so the server can report them instead of them
 * silently disappearing.
 */
export function parseEmailList(text: string): string[] {
	const addresses: string[] = [];
	let words: string[] = [];

	const keepWords = () => {
		addresses.push(...words);
		words = [];
	};

	for (const [token] of text.matchAll(TOKEN)) {
		if (token.startsWith("<")) {
			words = [];
			const address = token.slice(1, -1).trim();
			if (address) {
				addresses.push(address);
			}
		} else if (token.startsWith('"')) {
			words.push(token.slice(1, -1).trim());
		} else if (token.includes("@")) {
			keepWords();
			addresses.push(token);
		} else {
			words.push(token);
		}
	}
	keepWords();

	return addresses.filter(Boolean);
}
