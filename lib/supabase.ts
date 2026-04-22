import { createClient } from "@supabase/supabase-js";

// TODO(auth): This client uses the service role key and bypasses RLS. The POST
// routes that call it (/api/scan, /api/trade, /api/trades/refresh) are
// currently protected only by enforceRateLimit — replace with a real auth gate
// (session JWT or server-only bearer token) before any public deployment.
export function createServerSupabaseClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}
