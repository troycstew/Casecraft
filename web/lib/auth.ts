import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

/**
 * Verifies the caller's Supabase access token from the Authorization
 * header and returns their user id. Every mutating API route in this
 * app uses this instead of trusting a user_id in the request body, so a
 * member can never act as someone else — same pattern already used in
 * app/api/checkout/create-session/route.ts, pulled out here so the new
 * request/listing routes don't each repeat it.
 *
 * Usage:
 *   const auth = await requireUser(request);
 *   if (auth instanceof NextResponse) return auth;
 *   const { userId } = auth;
 */
export async function requireUser(
  request: Request
): Promise<{ userId: string } | NextResponse> {
  const authHeader = request.headers.get("authorization") || "";
  const accessToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!accessToken) {
    return NextResponse.json({ error: "Missing Authorization header." }, { status: 401 });
  }

  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !data?.user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  return { userId: data.user.id };
}
