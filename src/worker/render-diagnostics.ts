export function renderErrorSummary(log: string): string | undefined {
	const plain = log.replace(/\x1b\[[\d;]*m/g, "");
	const match =
		/Unable to render [^\n]+ because it is undefined!?/i.exec(plain) ??
		/(?:TypeError|ReferenceError|SyntaxError|AstroError): [^\n]+/i.exec(plain);
	return match?.[0].slice(0, 360);
}
