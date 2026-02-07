import { Hono } from "hono";
import type { ClaudeCodeController } from "../controller.js";
import { ActionTracker } from "./action-tracker.js";
import { buildRoutes } from "./routes.js";
import type { CreateApiOptions } from "./types.js";

/**
 * Create a standalone Hono app that exposes a ClaudeCodeController as a REST API.
 *
 * **Mode 1 – Pre-initialized controller:**
 * Pass an already-initialized controller. The API is ready to use immediately.
 *
 * **Mode 2 – Lazy init via API:**
 * Pass no controller (or `null`). Use `POST /session/init` to create a session,
 * passing `env`, `teamName`, `cwd`, etc. in the request body.
 *
 * @example
 * ```ts
 * // Mode 1: pre-initialized controller
 * import { ClaudeCodeController } from "claude-code-controller";
 * import { createApi } from "claude-code-controller/api";
 *
 * const controller = new ClaudeCodeController({ teamName: "my-team" });
 * await controller.init();
 * const app = createApi(controller);
 *
 * // Mode 2: init via API (supports env vars)
 * const app = createApi();
 * // Then: POST /session/init { "teamName": "t1", "env": { "ANTHROPIC_API_KEY": "..." } }
 * ```
 */
export function createApi(
  controller?: ClaudeCodeController | null,
  options?: CreateApiOptions
): Hono {
  const tracker = new ActionTracker();

  // If a controller was provided, attach the tracker immediately
  if (controller) {
    tracker.attach(controller);
  }

  const state = { controller: controller ?? null, tracker };

  const app = new Hono();
  const routes = buildRoutes(state);
  const basePath = options?.basePath ?? "/";

  app.route(basePath, routes);

  // Global error handler
  app.onError((err, c) => {
    const message =
      err instanceof Error ? err.message : "Internal server error";
    return c.json({ error: message }, 500);
  });

  return app;
}

// Re-export types for consumers
export { ActionTracker } from "./action-tracker.js";

export type {
  CreateApiOptions,
  InitSessionBody,
  SpawnAgentBody,
  SendMessageBody,
  BroadcastBody,
  ApprovePlanBody,
  ApprovePermissionBody,
  CreateTaskBody,
  UpdateTaskBody,
  AssignTaskBody,
  ApiError,
  AgentResponse,
  SessionResponse,
  HealthResponse,
  ActionsResponse,
  UnassignedTask,
} from "./types.js";

export type {
  PendingApproval,
  IdleAgent,
} from "./action-tracker.js";
