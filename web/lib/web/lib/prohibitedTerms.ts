// Keep this pattern in sync with the marketplace_items_prohibited_terms
// check constraint added in
// supabase/migrations/0003_expiry_disclaimers_terms.sql. Checking here
// first gives a friendly, specific error message before the insert is
// even attempted; the database constraint is the real backstop in case
// this ever drifts, or a write happens from somewhere other than this
// API.
const PROHIBITED_TERMS_PATTERN = /(legal advice|representation|court appearance)/i;

export function findProhibitedTerm(title: string): string | null {
  const match = title.match(PROHIBITED_TERMS_PATTERN);
  return match ? match[0] : null;
}
