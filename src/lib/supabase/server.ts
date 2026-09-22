// Server-side Supabase client for Server Components / Route Handlers (App
// Router). Reads/writes the session via Next.js's cookies() store. The
// setAll() write can fail here (Server Components can't set cookies) --
// that's expected and safe to swallow, since middleware.ts is what actually
// refreshes the session cookie on every request; this client only needs to
// read it.
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
          } catch {
            // Called from a Server Component -- middleware.ts refreshes the
            // session cookie instead, so this is safe to ignore.
          }
        },
      },
    },
  );
}
