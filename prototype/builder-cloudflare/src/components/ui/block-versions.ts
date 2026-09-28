import type { BlockComponent, BlockValue } from "emdash/ui";

export type BlockVersionComponents<T extends BlockValue> = {
	[Version in T["_version"]]: BlockComponent<Extract<T, { _version: Version }>>;
};

export function defineBlockVersionComponents<T extends BlockValue>(
	components: BlockVersionComponents<T>,
): BlockVersionComponents<T> {
	return components;
}

export function resolveBlockVersionComponent<T extends BlockValue>(
	value: T,
	components: BlockVersionComponents<T>,
): BlockComponent<T> {
	// The exhaustive mapped type and runtime lookup use this same object.
	const component = (components as Record<number, BlockComponent<T> | undefined>)[value._version];
	if (!component) {
		throw new Error(`No renderer exists for block ${value._type} version ${value._version}.`);
	}
	return component;
}
