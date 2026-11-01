// Dev-only one-click login switch. Never on in production builds, and off
// unless explicitly enabled in .env.local.
export function devLoginEnabled(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.DEV_LOGIN_ENABLED === "true" && Boolean(process.env.DEV_LOGIN_EMAIL);
}

export function devLoginEmail(): string {
  return process.env.DEV_LOGIN_EMAIL ?? "";
}
