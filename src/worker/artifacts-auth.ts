export function artifactsGitEnv(token: string): Record<string, string> {
	return {
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "http.extraHeader",
		GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
		GIT_TERMINAL_PROMPT: "0",
	};
}

/**
 * The token goes in a header, not the URL. Its `?expires=` suffix breaks Git's
 * URL parsing and zsh globbing, and a URL credential stays in `.git/config`.
 */
export function artifactsCloneCommand(remote: string, token: string, directory: string): string {
	return `git -c http.extraHeader="Authorization: Bearer ${token}" clone ${remote} ${directory}`;
}

export function redactArtifactsToken(text: string): string {
	return text.replace(/art_v\d+_[a-z0-9_-]+(?:\?expires=\d+)?/gi, "art_***");
}
