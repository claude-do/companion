import { Hono } from "hono";
import { ClaudeCodeController } from "../controller.js";
import { ActionTracker } from "./action-tracker.js";
import type {
  InitSessionBody,
  SpawnAgentBody,
  SendMessageBody,
  BroadcastBody,
  ApprovePlanBody,
  ApprovePermissionBody,
  CreateTaskBody,
  UpdateTaskBody,
  AssignTaskBody,
} from "./types.js";

const startTime = Date.now();

export interface ApiState {
  controller: ClaudeCodeController | null;
  tracker: ActionTracker;
}

function getController(state: ApiState): ClaudeCodeController {
  if (!state.controller) {
    throw new Error(
      "No active session. Call POST /session/init first."
    );
  }
  return state.controller;
}

export function buildRoutes(state: ApiState) {
  const api = new Hono();

  // ─── Health ──────────────────────────────────────────────────────────

  api.get("/health", (c) => {
    return c.json({
      status: "ok",
      uptime: Date.now() - startTime,
      session: state.controller !== null,
    });
  });

  // ─── Session ─────────────────────────────────────────────────────────

  api.get("/session", (c) => {
    if (!state.controller) {
      return c.json({ initialized: false, teamName: "" });
    }
    return c.json({
      initialized: true,
      teamName: state.controller.teamName,
    });
  });

  api.post("/session/init", async (c) => {
    const body = await c.req.json<InitSessionBody>().catch(() => ({} as InitSessionBody));

    // Shutdown existing session if any
    if (state.controller) {
      state.tracker.clear();
      await state.controller.shutdown();
      state.controller = null;
    }

    const controller = new ClaudeCodeController({
      teamName: body.teamName,
      cwd: body.cwd,
      claudeBinary: body.claudeBinary,
      env: body.env,
      logLevel: "info",
    });

    await controller.init();
    state.controller = controller;
    state.tracker.attach(controller);

    return c.json({
      initialized: true,
      teamName: controller.teamName,
    }, 201);
  });

  api.post("/session/shutdown", async (c) => {
    const ctrl = getController(state);
    state.tracker.clear();
    await ctrl.shutdown();
    state.controller = null;
    return c.json({ ok: true });
  });

  // ─── Actions ─────────────────────────────────────────────────────────

  api.get("/actions", async (c) => {
    const ctrl = getController(state);
    const approvals = state.tracker.getPendingApprovals();
    const idleAgents = state.tracker.getIdleAgents();

    const tasks = await ctrl.tasks.list();
    const unassignedTasks = tasks
      .filter((t) => !t.owner && t.status !== "completed")
      .map((t) => ({
        id: t.id,
        subject: t.subject,
        description: t.description,
        status: t.status,
        action: `POST /tasks/${t.id}/assign`,
      }));

    const pending =
      approvals.length + unassignedTasks.length + idleAgents.length;

    return c.json({ pending, approvals, unassignedTasks, idleAgents });
  });

  api.get("/actions/approvals", (_c) => {
    getController(state); // ensure session exists
    return _c.json(state.tracker.getPendingApprovals());
  });

  api.get("/actions/tasks", async (c) => {
    const ctrl = getController(state);
    const tasks = await ctrl.tasks.list();
    const unassigned = tasks
      .filter((t) => !t.owner && t.status !== "completed")
      .map((t) => ({
        id: t.id,
        subject: t.subject,
        description: t.description,
        status: t.status,
        action: `POST /tasks/${t.id}/assign`,
      }));
    return c.json(unassigned);
  });

  api.get("/actions/idle-agents", (_c) => {
    getController(state); // ensure session exists
    return _c.json(state.tracker.getIdleAgents());
  });

  // ─── Agents ──────────────────────────────────────────────────────────

  api.get("/agents", async (c) => {
    const ctrl = getController(state);
    const config = await ctrl.team.getConfig();
    const agents = config.members
      .filter((m) => m.name !== "controller")
      .map((m) => ({
        name: m.name,
        type: m.agentType,
        model: m.model,
        running: ctrl.isAgentRunning(m.name),
      }));
    return c.json(agents);
  });

  api.post("/agents", async (c) => {
    const ctrl = getController(state);
    const body = await c.req.json<SpawnAgentBody>();
    if (!body.name) {
      return c.json({ error: "name is required" }, 400);
    }

    const agentType = body.type || "general-purpose";
    state.tracker.registerAgentType(body.name, agentType);

    const handle = await ctrl.spawnAgent({
      name: body.name,
      type: body.type,
      model: body.model,
      cwd: body.cwd,
      permissions: body.permissions,
      env: body.env,
    });

    return c.json(
      {
        name: handle.name,
        pid: handle.pid,
        running: handle.isRunning,
      },
      201
    );
  });

  api.get("/agents/:name", async (c) => {
    const ctrl = getController(state);
    const name = c.req.param("name");
    const config = await ctrl.team.getConfig();
    const member = config.members.find((m) => m.name === name);
    if (!member) {
      return c.json({ error: `Agent "${name}" not found` }, 404);
    }
    return c.json({
      name: member.name,
      type: member.agentType,
      model: member.model,
      running: ctrl.isAgentRunning(name),
    });
  });

  api.post("/agents/:name/messages", async (c) => {
    const ctrl = getController(state);
    const name = c.req.param("name");
    const body = await c.req.json<SendMessageBody>();
    if (!body.message) {
      return c.json({ error: "message is required" }, 400);
    }
    await ctrl.send(name, body.message, body.summary);
    return c.json({ ok: true });
  });

  api.post("/agents/:name/kill", async (c) => {
    const ctrl = getController(state);
    const name = c.req.param("name");
    await ctrl.killAgent(name);
    return c.json({ ok: true });
  });

  api.post("/agents/:name/shutdown", async (c) => {
    const ctrl = getController(state);
    const name = c.req.param("name");
    await ctrl.sendShutdownRequest(name);
    return c.json({ ok: true });
  });

  api.post("/agents/:name/approve-plan", async (c) => {
    const ctrl = getController(state);
    const name = c.req.param("name");
    const body = await c.req.json<ApprovePlanBody>();
    if (!body.requestId) {
      return c.json({ error: "requestId is required" }, 400);
    }
    await ctrl.sendPlanApproval(
      name,
      body.requestId,
      body.approve ?? true,
      body.feedback
    );
    state.tracker.resolveApproval(body.requestId);
    return c.json({ ok: true });
  });

  api.post("/agents/:name/approve-permission", async (c) => {
    const ctrl = getController(state);
    const name = c.req.param("name");
    const body = await c.req.json<ApprovePermissionBody>();
    if (!body.requestId) {
      return c.json({ error: "requestId is required" }, 400);
    }
    await ctrl.sendPermissionResponse(
      name,
      body.requestId,
      body.approve ?? true
    );
    state.tracker.resolveApproval(body.requestId);
    return c.json({ ok: true });
  });

  // ─── Broadcast ───────────────────────────────────────────────────────

  api.post("/broadcast", async (c) => {
    const ctrl = getController(state);
    const body = await c.req.json<BroadcastBody>();
    if (!body.message) {
      return c.json({ error: "message is required" }, 400);
    }
    await ctrl.broadcast(body.message, body.summary);
    return c.json({ ok: true });
  });

  // ─── Tasks ───────────────────────────────────────────────────────────

  api.get("/tasks", async (c) => {
    const ctrl = getController(state);
    const tasks = await ctrl.tasks.list();
    return c.json(tasks);
  });

  api.post("/tasks", async (c) => {
    const ctrl = getController(state);
    const body = await c.req.json<CreateTaskBody>();
    if (!body.subject || !body.description) {
      return c.json({ error: "subject and description are required" }, 400);
    }
    const taskId = await ctrl.createTask(body);
    const task = await ctrl.tasks.get(taskId);
    return c.json(task, 201);
  });

  api.get("/tasks/:id", async (c) => {
    const ctrl = getController(state);
    const id = c.req.param("id");
    try {
      const task = await ctrl.tasks.get(id);
      return c.json(task);
    } catch {
      return c.json({ error: `Task "${id}" not found` }, 404);
    }
  });

  api.patch("/tasks/:id", async (c) => {
    const ctrl = getController(state);
    const id = c.req.param("id");
    const body = await c.req.json<UpdateTaskBody>();
    try {
      const task = await ctrl.tasks.update(id, body);
      return c.json(task);
    } catch {
      return c.json({ error: `Task "${id}" not found` }, 404);
    }
  });

  api.delete("/tasks/:id", async (c) => {
    const ctrl = getController(state);
    const id = c.req.param("id");
    try {
      await ctrl.tasks.delete(id);
      return c.json({ ok: true });
    } catch {
      return c.json({ error: `Task "${id}" not found` }, 404);
    }
  });

  api.post("/tasks/:id/assign", async (c) => {
    const ctrl = getController(state);
    const id = c.req.param("id");
    const body = await c.req.json<AssignTaskBody>();
    if (!body.agent) {
      return c.json({ error: "agent is required" }, 400);
    }
    try {
      await ctrl.assignTask(id, body.agent);
      return c.json({ ok: true });
    } catch {
      return c.json({ error: `Task "${id}" not found` }, 404);
    }
  });

  return api;
}
