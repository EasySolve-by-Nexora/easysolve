// Test-only preload (NODE_OPTIONS="--import ./tests/browser/stub-resend.mjs").
// The worker delivers welcome email through Resend. Browser tests answer any
// provider requests locally instead of contacting the provider. Every other
// request is passed through untouched.
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
