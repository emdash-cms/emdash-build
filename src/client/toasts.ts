import { createKumoToastManager } from "@cloudflare/kumo";

/** App-wide toasts, rendered by the `<Toasty>` at the root. */
export const toasts = createKumoToastManager();
