// Email + password login with Supabase Auth.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";
import { CONFIG } from "../config.js";

export const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

// Where links in auth emails (confirm sign-up, reset password) send people back to.
const RETURN_URL = location.origin + location.pathname;

export async function currentSession() {
  const { data } = await supabase.auth.getSession();
  return data.session ?? null;
}

/** Fresh access token for API calls (refreshes automatically when needed). */
export async function accessToken() {
  const s = await currentSession();
  return s?.access_token ?? null;
}

export function onAuthChange(cb) {
  return supabase.auth.onAuthStateChange((event, session) => cb(session, event));
}

function friendly(error) {
  const m = String(error?.message || error || "");
  if (/invalid login credentials/i.test(m)) return "Wrong email or password.";
  if (/email not confirmed/i.test(m)) return "Please confirm your email first. Check your inbox for the link.";
  if (/already registered|already been registered/i.test(m)) return "That email already has an account. Sign in instead.";
  if (/rate limit/i.test(m)) return "Too many attempts. Please wait a minute and try again.";
  if (/password.*(6|short|weak)/i.test(m)) return "Password must be at least 6 characters.";
  return m || "Something went wrong. Please try again.";
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(friendly(error));
  return data.session;
}

/** Returns { session } when signed in immediately, or { needsConfirmation: true }. */
export async function signUp(email, password) {
  const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: RETURN_URL } });
  if (error) throw new Error(friendly(error));
  if (data.session) return { session: data.session };
  // Supabase returns a user with no identities when the email is already registered.
  if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
    throw new Error("That email already has an account. Sign in instead.");
  }
  return { needsConfirmation: true };
}

export async function sendPasswordReset(email) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: RETURN_URL });
  if (error) throw new Error(friendly(error));
}

export async function updatePassword(password) {
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw new Error(friendly(error));
}

export async function signOut() {
  await supabase.auth.signOut();
}
