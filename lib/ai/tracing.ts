// Observability (Module 5): every AI call is traced in Langfuse. The AI SDK
// emits OpenTelemetry spans for each agent run (invoke_agent), each model call
// (chat, with tokens and time) and each tool call (execute_tool). This file
// sends them to Langfuse, which adds the cost. Nothing happens, and nothing
// breaks, when the Langfuse keys aren't set.
//
// Keys (in .env.local and the Vercel project): LANGFUSE_PUBLIC_KEY,
// LANGFUSE_SECRET_KEY and LANGFUSE_BASE_URL.
import { OpenTelemetry } from "@ai-sdk/otel";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { registerTelemetry } from "ai";

/**
 * The Langfuse settings from the environment, with stray spaces and line
 * breaks removed (a secret pasted or piped in often ends with one, and a URL
 * that ends with one can't be used).
 */
export function langfuseConfig() {
  return {
    publicKey: process.env.LANGFUSE_PUBLIC_KEY?.trim() ?? "",
    secretKey: process.env.LANGFUSE_SECRET_KEY?.trim() ?? "",
    baseUrl:
      process.env.LANGFUSE_BASE_URL?.trim() || "https://cloud.langfuse.com",
  };
}

export function isTracingConfigured(): boolean {
  const { publicKey, secretKey } = langfuseConfig();
  return Boolean(publicKey && secretKey);
}

type Tracing = { processor: LangfuseSpanProcessor };
const globalTracing = globalThis as unknown as { __copperTracing?: Tracing };

/**
 * Starts sending traces to Langfuse. Safe to call more than once (the dev
 * server reloads files). Returns false when the keys aren't set.
 */
export function setupTracing(): boolean {
  if (!isTracingConfigured()) return false;
  if (globalTracing.__copperTracing) return true;
  // "immediate" sends each span as it ends, which suits a serverless host that
  // can stop a function as soon as it has answered.
  const processor = new LangfuseSpanProcessor({
    ...langfuseConfig(),
    exportMode: "immediate",
  });
  new NodeTracerProvider({ spanProcessors: [processor] }).register();
  registerTelemetry(new OpenTelemetry());
  globalTracing.__copperTracing = { processor };
  return true;
}

/** Waits until every finished span has been sent. Call it before a script exits. */
export async function flushTraces(): Promise<void> {
  try {
    await globalTracing.__copperTracing?.processor.forceFlush();
  } catch {
    // Tracing must never break the app.
  }
}
