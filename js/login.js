// Login / sign-up / password-reset screens.
import { signIn, signUp, sendPasswordReset, updatePassword } from "./auth.js";

const $ = (id) => document.getElementById(id);

function setMsg(id, msg) {
  const el = $(id);
  el.textContent = msg || "";
  el.classList.toggle("hidden", !msg);
}

const MODES = {
  signin: { title: "Welcome back", sub: "Sign in with your email and password.", button: "Sign in", autocomplete: "current-password" },
  signup: { title: "Create your account", sub: "Use your work email. You'll use it to sign in next time.", button: "Create account", autocomplete: "new-password" },
  forgot: { title: "Reset your password", sub: "Enter your email and we'll send you a reset link.", button: "Send reset link" },
};

export function initLogin({ onSignedIn }) {
  let mode = "signin";

  function setMode(next) {
    mode = next;
    const m = MODES[mode];
    $("auth-title").textContent = m.title;
    $("auth-sub").textContent = m.sub;
    $("auth-submit").textContent = m.button;
    $("auth-password-field").classList.toggle("hidden", mode === "forgot");
    $("auth-forgot").textContent = mode === "forgot" ? "Back to sign in" : "Forgot password?";
    $("auth-forgot").classList.toggle("hidden", mode === "signup");
    if (m.autocomplete) $("auth-password").setAttribute("autocomplete", m.autocomplete);
    document.querySelectorAll(".auth-tab").forEach((t) => {
      const on = t.dataset.mode === (mode === "forgot" ? "signin" : mode);
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", String(on));
    });
    setMsg("auth-error", "");
    setMsg("auth-info", "");
  }

  document.querySelectorAll(".auth-tab").forEach((t) => t.addEventListener("click", () => setMode(t.dataset.mode)));
  $("auth-forgot").addEventListener("click", () => setMode(mode === "forgot" ? "signin" : "forgot"));

  $("auth-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("auth-email").value.trim().toLowerCase();
    const password = $("auth-password").value;
    setMsg("auth-error", "");
    setMsg("auth-info", "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return setMsg("auth-error", "Enter a valid email address.");
    if (mode !== "forgot" && password.length < 6) return setMsg("auth-error", "Password must be at least 6 characters.");

    const btn = $("auth-submit");
    const label = btn.textContent;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner light"></span> Please wait…`;
    try {
      if (mode === "signin") {
        onSignedIn(await signIn(email, password));
      } else if (mode === "signup") {
        const r = await signUp(email, password);
        if (r.session) onSignedIn(r.session);
        else {
          setMode("signin");
          $("auth-email").value = email;
          setMsg("auth-info", `Account created. We sent a confirmation link to ${email} — click it, then sign in here.`);
        }
      } else {
        await sendPasswordReset(email);
        setMsg("auth-info", `If ${email} has an account, a reset link is on its way.`);
      }
    } catch (err) {
      setMsg("auth-error", err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });

  $("reset-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pw = $("reset-password").value;
    setMsg("reset-error", "");
    if (pw.length < 6) return setMsg("reset-error", "Password must be at least 6 characters.");
    try {
      await updatePassword(pw);
      location.hash = "";
      location.reload();
    } catch (err) {
      setMsg("reset-error", err.message);
    }
  });

  return { setMode };
}
