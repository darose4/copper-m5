// Next.js runs register() once when the server starts. It switches on Langfuse
// tracing (lib/ai/tracing.ts) when the Langfuse keys are set.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { setupTracing } = await import("@/lib/ai/tracing");
  setupTracing();
}
