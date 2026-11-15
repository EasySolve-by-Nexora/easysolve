// Test-only preload (NODE_OPTIONS="--import ./tests/browser/stub-resend.mjs").
// Signup sends a welcome email through Resend and fails closed, so browser
// tests that run the real server answer Resend requests locally instead of
// contacting the provider. Every other request is passed through untouched.
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  if (url.startsWith("https://api.resend.com/"))
    return new Response(JSON.stringify({ id: "browser-test-email" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  return realFetch(input, init);
};
