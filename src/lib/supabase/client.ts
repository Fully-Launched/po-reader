// Browser-side Supabase client -- used by the login page and the sidebar's
// logout action (see InvoiceUploader.tsx). Not the source of truth for
// whether a request is authenticated -- middleware.ts (server-side) is,
// since a browser client can't be trusted to enforce access control on its
// own. See src/lib/supabase/server.ts for the server-side equivalent.
import { createBrowserClient } from "@supabase/ssr";

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  );
}
