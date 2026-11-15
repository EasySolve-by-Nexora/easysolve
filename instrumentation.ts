export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./lib/load-env");
    if (
      process.env.NODE_ENV === "production" &&
      process.env.TRUST_PROXY !== "true"
    )
      console.error(
        "TRUST_PROXY is not true: sign-in, sign-up and recovery will return 503 until it is set behind a proxy that overwrites X-Forwarded-For.",
      );
    const { recordProviderRuntime } = await import("./lib/provider-runtime");
    await recordProviderRuntime("web");
  }
}
