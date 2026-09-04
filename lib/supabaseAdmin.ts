import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceRoleKey) {
  throw new Error(
    "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set. Copy .env.example to .env.local and fill them in from your Supabase project's API settings."
  );
}

// Service-role client: bypasses row-level security entirely. Only ever
// import this in server-only code (API routes, the webhook handler) —
// never send this key to the browser, and never import this file from
// a "use client" component. The webhook handler needs it because Stripe
// calling our server isn't an authenticated Supabase user session, so
// there's no auth.uid() for RLS to check against.
export const supabaseAdmin = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
