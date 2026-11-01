/** Turns Supabase auth errors into something a person can act on. */
export function friendlyAuthError(message: string): string {
  if (/code verifier/i.test(message)) {
    return "That link was opened in a different browser than the one you requested it from. Request a new link and open it in this browser.";
  }
  if (/expired|invalid/i.test(message)) {
    return "That sign-in link was already used or has expired. Request a new one below.";
  }
  return message;
}
