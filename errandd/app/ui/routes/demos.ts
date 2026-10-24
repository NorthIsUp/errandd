import type { RunAgentInput } from "@ag-ui/client";
import type { RouteHandler } from "./types";

/** Direct AG-UI fixture shared by framework demos; never invokes a model. */
export const scriptedAgui: RouteHandler = async (ctx) => {
  let input: RunAgentInput;
  try {
    input = (await ctx.req.json()) as RunAgentInput;
    if (
      !input ||
      typeof input.threadId !== "string" ||
      typeof input.runId !== "string" ||
      !Array.isArray(input.messages) ||
      (input.resume !== undefined &&
        (!Array.isArray(input.resume) ||
          input.resume.some(
            (entry) =>
              !entry ||
              typeof entry.interruptId !== "string" ||
              !["resolved", "cancelled"].includes(entry.status),
          ))) ||
      input.messages.some((message) => !message || typeof message.role !== "string")
    ) {
      return Response.json({ error: "Expected an AG-UI run input" }, { status: 400 });
    }
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { scriptedChatResponse } = await import("../services/chatDemo");
  return scriptedChatResponse(input);
};

/** Authenticated read-only fixture endpoint; no live-site proxy or tool runs. */
export const chatExamples: RouteHandler = async () => {
  const { readChatExamples } = await import("../services/chatExamples");
  const data = await readChatExamples();
  return new Response(
    JSON.stringify(
      data ?? { error: "No captured chats yet. Import examples from your Errandd instance first." },
    ),
    {
      status: data ? 200 : 404,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    },
  );
};
