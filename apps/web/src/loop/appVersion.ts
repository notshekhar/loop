/**
 * The app's own version — which the handlers also report as the server's (see
 * `serverConfig.ts`: anything else trips the version-skew banner, meaningless
 * when the UI and the agent ship together).
 *
 * Its own module so the handlers do not import `branding.ts`, which reads the
 * desktop bridge and Vite's `import.meta.env` at load: the mobile app runs the
 * same handlers with neither. Read defensively for the same reason.
 */
const env = (import.meta as { env?: { APP_VERSION?: string } }).env;

export const APP_VERSION: string = env?.APP_VERSION || "0.0.0";
