import type { ClaudeCodeController } from "../controller.js";
import type {
  PlanApprovalRequestMessage,
  PermissionRequestMessage,
} from "../types.js";

export interface PendingApproval {
  type: "plan" | "permission";
  agent: string;
  requestId: string;
  timestamp: string;
  action: string;
  // plan-specific
  planContent?: string;
  // permission-specific
  toolName?: string;
  description?: string;
}

export interface IdleAgent {
  name: string;
  type: string;
  idleSince: string;
  action: string;
}

/**
 * Listens to controller events and maintains an in-memory snapshot
 * of all actions that need attention (approvals, idle agents).
 */
export class ActionTracker {
  private approvals = new Map<string, PendingApproval>();
  private idles = new Map<string, IdleAgent>();
  private agentTypes = new Map<string, string>();

  attach(controller: ClaudeCodeController): void {
    controller.on(
      "plan:approval_request",
      (agent: string, parsed: PlanApprovalRequestMessage) => {
        this.approvals.set(parsed.requestId, {
          type: "plan",
          agent,
          requestId: parsed.requestId,
          timestamp: parsed.timestamp,
          planContent: parsed.planContent,
          action: `POST /agents/${agent}/approve-plan`,
        });
      }
    );

    controller.on(
      "permission:request",
      (agent: string, parsed: PermissionRequestMessage) => {
        this.approvals.set(parsed.requestId, {
          type: "permission",
          agent,
          requestId: parsed.requestId,
          timestamp: parsed.timestamp,
          toolName: parsed.toolName,
          description: parsed.description,
          action: `POST /agents/${agent}/approve-permission`,
        });
      }
    );

    controller.on("idle", (agent: string) => {
      this.idles.set(agent, {
        name: agent,
        type: this.agentTypes.get(agent) ?? "unknown",
        idleSince: new Date().toISOString(),
        action: `POST /agents/${agent}/messages`,
      });
    });

    // Agent becomes active again → no longer idle
    controller.on("message", (agent: string) => {
      this.idles.delete(agent);
    });

    controller.on("agent:spawned", (agent: string) => {
      this.idles.delete(agent);
    });

    controller.on("agent:exited", (agent: string) => {
      this.idles.delete(agent);
    });
  }

  /** Track agent type so idle entries have the right type. */
  registerAgentType(name: string, type: string): void {
    this.agentTypes.set(name, type);
  }

  resolveApproval(requestId: string): void {
    this.approvals.delete(requestId);
  }

  getPendingApprovals(): PendingApproval[] {
    return Array.from(this.approvals.values());
  }

  getIdleAgents(): IdleAgent[] {
    return Array.from(this.idles.values());
  }

  clear(): void {
    this.approvals.clear();
    this.idles.clear();
    this.agentTypes.clear();
  }
}
