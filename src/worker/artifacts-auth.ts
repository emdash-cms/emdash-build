export function artifactsGitEnv(token: string): Record<string, string> {
	return {
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "http.extraHeader",
		GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
		GIT_TERMINAL_PROMPT: "0",
	};
}

/**
 * Artifacts accepts the token as the basic-auth password (the username
 * is ignored), per the docs: https://x:<token>@.../repo.git. This keeps
 * the user's clone to a single paste with no header gymnastics.
 */
export function artifactsCloneCommand(remote: string, token: string): string {
	return `git clone ${remote.replace(/^https:\/\//, `https://x:${token}@`)} my-site`;
}

export function redactArtifactsToken(text: string): string {
	return text.replace(/art_v\d+_[a-z0-9_-]+(?:\?expires=\d+)?/gi, "art_***");
}
