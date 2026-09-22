"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// Entry point for the whole app when unauthenticated -- middleware.ts
// redirects every other route here if there's no valid session. Shows
// ONLY this form, nothing from the dashboard/upload UI behind it. On
// success, redirects to "/" (the Dashboard) -- router.refresh() forces
// the server-rendered shell to re-check the now-present session cookie
// rather than serving a stale unauthenticated render from the cache.
export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    const supabase = createClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });

    if (signInError) {
      setError(signInError.message);
      setSubmitting(false);
      return;
    }

    router.push("/");
    router.refresh();
  }

  return (
    <div className="login-page">
      <form className="card login-card" onSubmit={handleSubmit}>
        <div className="brand-title" style={{ marginBottom: 4 }}>
          Comfort x Design
        </div>
        <div className="brand-subtitle" style={{ marginBottom: 24 }}>
          Purchase Order Generator
        </div>

        <div style={{ marginBottom: 12 }}>
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={submitting}
          />
        </div>

        <div style={{ marginBottom: 16 }}>
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={submitting}
          />
        </div>

        {error && (
          <div className="banner banner-error" style={{ marginBottom: 16 }}>
            <i className="ti ti-alert-circle" />
            {error}
          </div>
        )}

        <button type="submit" className="btn-primary" disabled={submitting}>
          {submitting ? "Signing in..." : "Sign in"}
        </button>
      </form>
    </div>
  );
}
