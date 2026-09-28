export function artifactsGitEnv(token: string): Record<string, string> {
	return {
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "http.extraHeader",
		GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
		GIT_TERMINAL_PROMPT: "0",
	};
}

export function redactArtifactsToken(text: string): string {
	return text.replace(/art_v\d+_[a-z0-9_-]+(?:\?expires=\d+)?/gi, "art_***");
}
