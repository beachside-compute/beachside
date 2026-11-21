import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createAgentSession,
  createReadToolDefinition,
  createWriteToolDefinition,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { defaultTextMapGetter, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/api";
import { registerGatewayModel, selectedGateway } from "./gateway";
import { answer, answerName, endSpan, OtlpExportError, traceContext, tracing } from "./telemetry";

const prompt =
  'Compute 2 + 2. Use write to create answer.txt containing exactly "4" followed by a newline. Then use read to verify the file and finish.';

async function runPi(telemetry: ReturnType<typeof tracing>, run: Span, offline: boolean) {
  const cwd = process.cwd();
  const answerPath = join(cwd, answerName);
  const gateway = selectedGateway(process.argv);
  const agentDir = offline || gateway ? cwd : getAgentDir();

  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: offline || gateway ? null : join(agentDir, "models.json"),
    modelsStorePath: join(cwd, "models-cache.json"),
    refreshOnCreate: false,
  });

  let model;

  if (offline) {
    const fixture = fauxProvider({ provider: "demo-scripted", models: [{ id: "arithmetic" }] });
    fixture.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: answerName, content: answer })),
      fauxAssistantMessage(fauxToolCall("read", { path: answerName })),
      (context) => {
        const result = context.messages.at(-1);

        if (
          result?.role !== "toolResult" ||
          result.isError ||
          !result.content.some((block) => block.type === "text" && block.text.trimEnd() === "4")
        ) {
          throw new Error("Scripted model did not receive the expected read result.");
        }

        return fauxAssistantMessage("Verified.");
      },
    ]);
    modelRuntime.registerNativeProvider(fixture.provider);
    model = fixture.getModel();
  } else if (gateway) {
    model = registerGatewayModel(modelRuntime, gateway, process.env);
  } else {
    const [provider, ...modelId] = (process.env.PI_TRACING_MODEL ?? "").split("/");
    model = modelRuntime.getModel(provider, modelId.join("/"));

    if (!model)
      throw new Error("Choose a configured Pi model with PI_TRACING_MODEL=provider/model-id.");
  }

  const settingsManager = SettingsManager.inMemory();
  settingsManager.setCompactionEnabled(false);
  settingsManager.setRetryEnabled(false);
  settingsManager.setCacheWarmingMode("off");

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });

  await resourceLoader.reload();

  function checkPath(path: string) {
    if (path !== answerPath) throw new Error("Only answer.txt is available in this demo.");
  }

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(),
    thinkingLevel: "off",
    tools: ["read", "write"],
    customTools: [
      createReadToolDefinition(cwd, {
        operations: {
          readFile: async (path) => {
            checkPath(path);

            return readFile(path);
          },
          access: async (path) => {
            checkPath(path);
            await access(path);
          },
        },
      }),
      createWriteToolDefinition(cwd, {
        operations: {
          mkdir: async (path) => {
            if (path !== cwd) throw new Error("Only the demo directory is available.");
          },
          writeFile: async (path, content) => {
            checkPath(path);
            await writeFile(path, content, "utf8");
          },
        },
      }),
    ].map(({ renderCall: _renderCall, renderResult: _renderResult, ...tool }) => tool),
  });

  const parent = trace.setSpan(ROOT_CONTEXT, run);
  let modelSpan: Span | undefined;
  let modelFailed = false;
  const toolSpans = new Map<string, Span>();
  let wrote = false;
  let readAfterWrite = false;

  const unsubscribe = session.subscribe((event) => {
    if (event.type === "turn_start") {
      if (modelSpan) endSpan(modelSpan, true);
      modelSpan = telemetry.start("pi.model", parent);
      modelSpan.setAttribute("gen_ai.provider.name", model.provider);
      modelSpan.setAttribute("gen_ai.request.model", model.id);
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      modelFailed = event.message.stopReason === "error" || event.message.stopReason === "aborted";

      if (modelSpan) {
        modelSpan.setAttribute("gen_ai.usage.input_tokens", event.message.usage.input);
        modelSpan.setAttribute("gen_ai.usage.output_tokens", event.message.usage.output);
        endSpan(modelSpan, modelFailed);
      }

      modelSpan = undefined;
    } else if (event.type === "tool_execution_start") {
      const span = telemetry.start(`pi.tool.${event.toolName}`, parent);
      toolSpans.set(event.toolCallId, span);
    } else if (event.type === "tool_execution_end") {
      const span = toolSpans.get(event.toolCallId);

      if (span) endSpan(span, event.isError);
      toolSpans.delete(event.toolCallId);

      if (event.isError) return;

      if (event.toolName === "write") {
        wrote = true;
        readAfterWrite = false;
      } else if (event.toolName === "read" && wrote) {
        readAfterWrite = true;
      }
    }
  });

  try {
    await session.prompt(prompt);

    if (modelFailed)
      throw new Error("Pi reported a model failure. Check the selected model and credentials.");

    if (!readAfterWrite) throw new Error("Pi did not successfully write and then read answer.txt.");
  } finally {
    unsubscribe();

    if (modelSpan) endSpan(modelSpan, true);

    for (const span of toolSpans.values()) endSpan(span, true);
    session.dispose();
    await modelRuntime.settleCredentialWrites();
  }
}

async function main() {
  const { TRACEPARENT, TRACESTATE, PI_TRACING_RUN_ID } = process.env;

  const parent = traceContext.extract(
    ROOT_CONTEXT,
    { traceparent: TRACEPARENT, tracestate: TRACESTATE },
    defaultTextMapGetter,
  );

  if (!trace.getSpanContext(parent) || !PI_TRACING_RUN_ID) {
    throw new Error("The Pi child requires a valid TRACEPARENT and PI_TRACING_RUN_ID.");
  }

  const offline = process.argv.includes("--offline");

  const telemetry = tracing(
    "beachside-pi-agent",
    PI_TRACING_RUN_ID,
    offline,
    undefined,
    process.env.PI_TRACING_SANDBOX_ID,
  );

  const run = telemetry.start("pi.run", parent);
  let failed = true;

  try {
    await runPi(telemetry, run, offline);
    failed = false;
  } finally {
    endSpan(run, failed);
    await telemetry.shutdown();
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(
      error instanceof OtlpExportError
        ? error.message
        : "Pi child failed. Check model configuration or use --offline to test the local workflow.",
    );
    process.exitCode = 1;
  }
}
