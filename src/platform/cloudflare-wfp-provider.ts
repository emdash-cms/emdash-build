import {
	PROVIDER_CONTRACT_VERSION,
	type DeployReleaseRequest,
	type EnsureSiteRequest,
	type ProviderAdapter,
	type ReleaseMutationRequest,
	type SetHostnameRequest,
} from "./contracts.js";
import {
	ProviderControlPlaneError,
	type ControlPlaneRpcResult,
	type ProviderControlPlane,
} from "../worker/provider-control-plane.js";

export class CloudflareWfpProviderAdapter implements ProviderAdapter {
	constructor(private readonly namespace: DurableObjectNamespace<ProviderControlPlane>) {}

	async getCapabilities() {
		return {
			contractVersion: PROVIDER_CONTRACT_VERSION,
			features: ["candidate-releases", "rollback"],
		};
	}

	async ensureSite(request: EnsureSiteRequest) {
		return this.call(() => this.stub(request.siteId).ensureSite(request));
	}
	async deployRelease(request: DeployReleaseRequest) {
		return this.call(() => this.stub(request.siteId).deployRelease(request));
	}
	async promoteRelease(request: ReleaseMutationRequest) {
		return this.call(() => this.stub(request.siteId).promoteRelease(request));
	}
	async rollbackRelease(request: ReleaseMutationRequest) {
		return this.call(() => this.stub(request.siteId).rollbackRelease(request));
	}
	async setHostname(request: SetHostnameRequest) {
		return this.call(() => this.stub(request.siteId).setHostname(request));
	}
	async getOperation(operationId: string) {
		const match = /^([a-f0-9]{32})\.[0-9a-f-]{36}$/.exec(operationId);
		if (!match) throw new Error("Invalid operation identifier.");
		const compact = match[1]!;
		const siteId = `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
		return this.call(() => this.stub(siteId).getOperation(operationId));
	}

	private stub(siteId: string) {
		return this.namespace.getByName(siteId.toLowerCase());
	}

	private async call<T>(action: () => Promise<ControlPlaneRpcResult<T>>): Promise<T> {
		try {
			const result = await action();
			if (!result.ok)
				throw new ProviderControlPlaneError(result.code, "Provider control-plane request failed.");
			return result.value;
		} catch (error) {
			const message = error instanceof Error ? error.message : "";
			const code = /(?:^|: )([A-Z][A-Z0-9_]+): /.exec(message)?.[1];
			if (code) throw new ProviderControlPlaneError(code, "Provider control-plane request failed.");
			throw error;
		}
	}
}
