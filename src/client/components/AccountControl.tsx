import { SignIn } from "@phosphor-icons/react/SignIn";

export function AccountControl({
	authenticated,
	onSignIn,
	onSignOut,
	onOpenProjects,
	inLandingNav = false,
}: {
	authenticated: boolean;
	onSignIn: () => void;
	onSignOut: () => void;
	onOpenProjects?: () => void;
	inLandingNav?: boolean;
}) {
	if (!authenticated) {
		return (
			<button
				type="button"
				onClick={onSignIn}
				className={inLandingNav ? "secondary-button landing-nav-link" : "secondary-button"}
			>
				{inLandingNav ? <SignIn size={14} weight="bold" aria-hidden="true" /> : null}
				Sign in
			</button>
		);
	}
	return (
		<div className="flex items-center gap-1.5" aria-label="Signed in account actions">
			{onOpenProjects ? (
				<button type="button" onClick={onOpenProjects} className="secondary-button">
					Open projects
				</button>
			) : null}
			<button type="button" onClick={onSignOut} className="secondary-button">
				Sign out
			</button>
		</div>
	);
}
