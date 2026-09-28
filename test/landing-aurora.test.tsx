// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import LandingAurora from "../src/client/components/LandingAurora.js";

const captured = vi.hoisted(() => ({
	uniforms: null as Record<string, { value: unknown }> | null,
}));

vi.mock("ogl", () => ({
	Renderer: class {
		gl = {
			drawingBufferWidth: 0,
			drawingBufferHeight: 0,
			clearColor() {},
			getExtension: () => ({ loseContext() {} }),
		};
		private readonly dpr: number;

		constructor({ dpr }: { dpr: number }) {
			this.dpr = dpr;
		}

		setSize(width: number, height: number) {
			this.gl.drawingBufferWidth = width * this.dpr;
			this.gl.drawingBufferHeight = height * this.dpr;
		}

		render() {}
	},
	Program: class {
		uniforms: Record<string, { value: unknown }>;

		constructor(_gl: unknown, { uniforms }: { uniforms: Record<string, { value: unknown }> }) {
			this.uniforms = uniforms;
			captured.uniforms = uniforms;
		}
	},
	Triangle: class {},
	Mesh: class {},
	Color: class {
		r = 1;
		g = 0;
		b = 0;
	},
}));

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	captured.uniforms = null;
});

describe("landing aurora", () => {
	it.each([1, 2])("uses drawing-buffer resolution at %s× DPR", (dpr) => {
		vi.stubGlobal("WebGL2RenderingContext", class {});
		vi.stubGlobal(
			"ResizeObserver",
			class {
				observe() {}
				disconnect() {}
			},
		);
		vi.stubGlobal("requestAnimationFrame", () => 1);
		vi.stubGlobal("cancelAnimationFrame", () => {});
		vi.stubGlobal("devicePixelRatio", dpr);
		vi.stubGlobal("matchMedia", () => ({
			matches: true,
			addEventListener() {},
			removeEventListener() {},
		}));
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
			{} as WebGL2RenderingContext,
		);
		vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(320);
		vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(180);

		render(<LandingAurora />);

		expect(captured.uniforms?.uResolution?.value).toEqual([320 * dpr, 180 * dpr]);
	});
});
