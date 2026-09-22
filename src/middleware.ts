// Gates the ENTIRE app behind a Supabase Auth session -- both pages and
// API routes, not just the frontend UI. This is the real access-control
// boundary: every matched request (see config.matcher below, which covers
// everything except static assets) is checked here before it ever reaches
// a page component or an /api/* route handler, so hitting an API route
// directly with no session cookie fails here, not just at the UI layer.
//
// Uses supabase.auth.getClaims() (validates the JWT), not getSession() or
// a raw cookie read -- see Supabase's own current server-side auth
// guidance: "Never trust supabase.auth.getSession() inside server code."
import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

const PUBLIC_PATHS = ["/login"];

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  );

  // Validates the JWT against Supabase Auth (not just reading the cookie),
  // and refreshes it if it's near expiry -- the write side of that refresh
  // happens via setAll() above.
  const { data } = await supabase.auth.getClaims();
  const isAuthenticated = data?.claims != null;

  const { pathname } = request.nextUrl;
  const isPublicPath = PUBLIC_PATHS.includes(pathname);
  const isApiPath = pathname.startsWith("/api/");

  if (!isAuthenticated && !isPublicPath) {
    // API routes get a plain 401 -- our own frontend's fetch() calls handle
    // that as a normal error response; a redirect would just hand back an
    // HTML login page where JSON was expected. Page requests get redirected
    // to the login screen instead of ever rendering the app behind it.
    if (isApiPath) {
      return NextResponse.json({ error: "Unauthorized -- please log in." }, { status: 401 });
    }
    const loginUrl = new URL("/login", request.url);
    return NextResponse.redirect(loginUrl);
  }

  if (isAuthenticated && pathname === "/login") {
    // Already signed in -- don't show the login form again.
    return NextResponse.redirect(new URL("/", request.url));
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.svg$).*)"],
};
