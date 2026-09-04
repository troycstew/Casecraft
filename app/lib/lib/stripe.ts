mport Stripe from "stripe";

const secretKey = process.env.STRIPE_SECRET_KEY;

if (!secretKey) {
  // Thrown at import time on purpose: every route that touches Stripe
  // needs this key, and failing loudly at startup beats a confusing
  // "cannot read property of undefined" three calls deep into a
  // checkout attempt.
  throw new Error(
    "STRIPE_SECRET_KEY is not set. Copy .env.example to .env.local and fill in your Stripe keys."
  );
}

export const stripe = new Stripe(secretKey, {
  apiVersion: "2024-06-20",
});
