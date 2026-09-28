import { Toasty } from "@cloudflare/kumo";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { toasts } from "./toasts.js";
import "./index.css";

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<Toasty toastManager={toasts}>
			<App />
		</Toasty>
	</StrictMode>,
);
