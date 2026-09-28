import { useEffect, useRef } from "react";
import { Color, Mesh, Program, Renderer, Triangle } from "ogl";

const VERTEX = `#version 300 es
in vec2 position;
void main() {
	gl_Position = vec4(position, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;

uniform float uTime;
uniform float uAmplitude;
uniform float uBlend;
uniform vec3 uColorStops[3];
uniform vec2 uResolution;

out vec4 fragColor;

vec3 permute(vec3 x) {
	return mod(((x * 34.0) + 1.0) * x, 289.0);
}

float snoise(vec2 v) {
	const vec4 C = vec4(0.211324865405187, 0.366025403784439,
		-0.577350269189626, 0.024390243902439);
	vec2 i = floor(v + dot(v, C.yy));
	vec2 x0 = v - i + dot(i, C.xx);
	vec2 i1 = x0.x > x0.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
	vec4 x12 = x0.xyxy + C.xxzz;
	x12.xy -= i1;
	i = mod(i, 289.0);
	vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0))
		+ i.x + vec3(0.0, i1.x, 1.0));
	vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy),
		dot(x12.zw, x12.zw)), 0.0);
	m = m * m;
	m = m * m;
	vec3 x = 2.0 * fract(p * C.www) - 1.0;
	vec3 h = abs(x) - 0.5;
	vec3 a0 = x - floor(x + 0.5);
	m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
	vec3 g;
	g.x = a0.x * x0.x + h.x * x0.y;
	g.yz = a0.yz * x12.xz + h.yz * x12.yw;
	return 130.0 * dot(m, g);
}

void main() {
	vec2 uv = gl_FragCoord.xy / uResolution;
	vec3 rampColor = mix(uColorStops[0], uColorStops[1], min(uv.x * 2.0, 1.0));
	rampColor = mix(rampColor, uColorStops[2], max(uv.x * 2.0 - 1.0, 0.0));
	float height = snoise(vec2(uv.x * 2.0 + uTime * 0.1, uTime * 0.25))
		* 0.5 * uAmplitude;
	height = exp(height);
	float intensity = 0.6 * (uv.y * 2.0 - height + 0.2);
	float alpha = smoothstep(0.2 - uBlend * 0.5, 0.2 + uBlend * 0.5, intensity);
	fragColor = vec4(rampColor * alpha, alpha);
}`;

const COLORS = ["#FFD58D", "#FFAA65", "#F88455"] as const;

export default function LandingAurora() {
	const containerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const container = containerRef.current;
		if (!container || !window.WebGL2RenderingContext) return;

		const canvas = document.createElement("canvas");
		if (!canvas.getContext("webgl2")) return;

		const renderer = new Renderer({
			canvas,
			alpha: true,
			premultipliedAlpha: true,
			depth: false,
			dpr: Math.min(window.devicePixelRatio || 1, 2),
		});
		const gl = renderer.gl;
		gl.clearColor(0, 0, 0, 0);

		const geometry = new Triangle(gl);
		const program = new Program(gl, {
			vertex: VERTEX,
			fragment: FRAGMENT,
			transparent: true,
			depthTest: false,
			depthWrite: false,
			uniforms: {
				uTime: { value: 0 },
				uAmplitude: { value: 0.8 },
				uBlend: { value: 0.45 },
				uColorStops: {
					value: COLORS.map((hex) => {
						const color = new Color(hex);
						return [color.r, color.g, color.b];
					}),
				},
				uResolution: { value: [1, 1] },
			},
		});
		const mesh = new Mesh(gl, { geometry, program });
		container.appendChild(canvas);

		const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
		let frame = 0;
		const render = (time: number) => {
			program.uniforms.uTime.value = time * 0.0005;
			renderer.render({ scene: mesh });
		};
		const animate = (time: number) => {
			frame = 0;
			render(time);
			if (!document.hidden && !reducedMotion.matches) frame = requestAnimationFrame(animate);
		};
		const updateAnimation = () => {
			cancelAnimationFrame(frame);
			frame = 0;
			if (document.hidden) return;
			if (reducedMotion.matches) render(0);
			else frame = requestAnimationFrame(animate);
		};
		const resize = () => {
			const width = container.clientWidth;
			const height = container.clientHeight;
			if (!width || !height) return;
			renderer.setSize(width, height);
			program.uniforms.uResolution.value = [gl.drawingBufferWidth, gl.drawingBufferHeight];
			if (reducedMotion.matches) render(0);
		};
		const resizeObserver = new ResizeObserver(resize);
		resizeObserver.observe(container);
		resize();
		updateAnimation();
		document.addEventListener("visibilitychange", updateAnimation);
		reducedMotion.addEventListener("change", updateAnimation);

		return () => {
			cancelAnimationFrame(frame);
			resizeObserver.disconnect();
			document.removeEventListener("visibilitychange", updateAnimation);
			reducedMotion.removeEventListener("change", updateAnimation);
			container.removeChild(canvas);
			gl.getExtension("WEBGL_lose_context")?.loseContext();
		};
	}, []);

	return <div ref={containerRef} className="landing-aurora" aria-hidden="true" />;
}
