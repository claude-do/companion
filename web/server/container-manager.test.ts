import { describe, it, expect, vi, beforeEach } from "vitest";
import { ContainerManager, type ContainerConfig, type ContainerInfo } from "./container-manager.js";

// Mock execSync
const mockExecSync = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execSync: mockExecSync,
}));

let manager: ContainerManager;

beforeEach(() => {
  vi.clearAllMocks();
  manager = new ContainerManager();
});

describe("ContainerManager", () => {
  describe("checkDocker", () => {
    it("returns true when Docker is available", () => {
      mockExecSync.mockReturnValueOnce("24.0.0");
      expect(manager.checkDocker()).toBe(true);
    });

    it("returns false when Docker is unavailable", () => {
      mockExecSync.mockImplementationOnce(() => {
        throw new Error("command not found: docker");
      });
      expect(manager.checkDocker()).toBe(false);
    });
  });

  describe("getDockerVersion", () => {
    it("returns version string", () => {
      mockExecSync.mockReturnValueOnce("24.0.7");
      expect(manager.getDockerVersion()).toBe("24.0.7");
    });

    it("returns null when unavailable", () => {
      mockExecSync.mockImplementationOnce(() => {
        throw new Error("not found");
      });
      expect(manager.getDockerVersion()).toBeNull();
    });
  });

  describe("listImages", () => {
    it("returns parsed image list", () => {
      mockExecSync.mockReturnValueOnce(
        "companion-dev:latest\nnode:22-slim\nubuntu:24.04",
      );
      expect(manager.listImages()).toEqual([
        "companion-dev:latest",
        "node:22-slim",
        "ubuntu:24.04",
      ]);
    });

    it("filters out <none> images", () => {
      mockExecSync.mockReturnValueOnce(
        "<none>:<none>\nnode:22-slim",
      );
      expect(manager.listImages()).toEqual(["node:22-slim"]);
    });

    it("returns empty array on error", () => {
      mockExecSync.mockImplementationOnce(() => {
        throw new Error("Docker not running");
      });
      expect(manager.listImages()).toEqual([]);
    });
  });

  describe("imageExists", () => {
    it("returns true for existing image", () => {
      mockExecSync.mockReturnValueOnce("[]"); // docker image inspect output
      expect(manager.imageExists("node:22-slim")).toBe(true);
    });

    it("returns false for missing image", () => {
      mockExecSync.mockImplementationOnce(() => {
        throw new Error("No such image");
      });
      expect(manager.imageExists("nonexistent:latest")).toBe(false);
    });
  });

  describe("createContainer", () => {
    const sessionId = "abc12345-6789-0000-0000-000000000000";
    const hostCwd = "/Users/stan/Dev/my-project";
    const config: ContainerConfig = {
      image: "companion-dev:latest",
      ports: [3000, 8080],
    };

    it("creates and starts a container with correct args", () => {
      // docker create → returns container ID
      mockExecSync.mockReturnValueOnce("sha256abcdef1234567890");
      // docker start
      mockExecSync.mockReturnValueOnce("");
      // docker port for port 3000
      mockExecSync.mockReturnValueOnce("0.0.0.0:49152");
      // docker port for port 8080
      mockExecSync.mockReturnValueOnce("0.0.0.0:49153");

      const info = manager.createContainer(sessionId, hostCwd, config);

      expect(info.containerId).toBe("sha256abcdef1234567890");
      expect(info.name).toBe("companion-abc12345");
      expect(info.image).toBe("companion-dev:latest");
      expect(info.state).toBe("running");
      expect(info.hostCwd).toBe(hostCwd);
      expect(info.containerCwd).toBe("/workspace");
      expect(info.portMappings).toEqual([
        { containerPort: 3000, hostPort: 49152 },
        { containerPort: 8080, hostPort: 49153 },
      ]);

      // Verify docker create was called with correct args
      const createCall = mockExecSync.mock.calls[0][0] as string;
      expect(createCall).toContain("docker create");
      expect(createCall).toContain("--name companion-abc12345");
      expect(createCall).toContain("--add-host=host.docker.internal:host-gateway");
      expect(createCall).toContain("-v");
      expect(createCall).toContain("/.claude:/root/.claude:ro");
      expect(createCall).toContain(`${hostCwd}:/workspace`);
      expect(createCall).toContain("-p 0:3000");
      expect(createCall).toContain("-p 0:8080");
      expect(createCall).toContain("companion-dev:latest");
      expect(createCall).toContain("sleep infinity");
    });

    it("passes extra volumes and env vars", () => {
      mockExecSync.mockReturnValueOnce("container123");
      mockExecSync.mockReturnValueOnce(""); // start
      // no ports

      const info = manager.createContainer(sessionId, hostCwd, {
        image: "node:22",
        ports: [],
        volumes: ["/data:/data:ro"],
        env: { NODE_ENV: "development", PORT: "3000" },
      });

      const createCall = mockExecSync.mock.calls[0][0] as string;
      expect(createCall).toContain("-v /data:/data:ro");
      expect(createCall).toContain("-e NODE_ENV=development");
      expect(createCall).toContain("-e PORT=3000");
      expect(info.portMappings).toEqual([]);
    });

    it("cleans up on failure and throws", () => {
      // docker create succeeds
      mockExecSync.mockReturnValueOnce("container123");
      // docker start fails
      mockExecSync.mockImplementationOnce(() => {
        throw new Error("Cannot start container");
      });
      // docker rm -f (cleanup) — allow it
      mockExecSync.mockReturnValueOnce("");

      expect(() =>
        manager.createContainer(sessionId, hostCwd, config),
      ).toThrow("Failed to create container");
    });

    it("tracks container in internal state", () => {
      mockExecSync.mockReturnValueOnce("cid123");
      mockExecSync.mockReturnValueOnce(""); // start

      manager.createContainer(sessionId, hostCwd, {
        image: "node:22",
        ports: [],
      });

      expect(manager.getContainer(sessionId)).toBeDefined();
      expect(manager.getContainer(sessionId)!.containerId).toBe("cid123");
      expect(manager.listContainers()).toHaveLength(1);
    });
  });

  describe("removeContainer", () => {
    it("removes a tracked container", () => {
      // Create first
      mockExecSync.mockReturnValueOnce("cid123");
      mockExecSync.mockReturnValueOnce(""); // start
      const sessionId = "sess-001";
      manager.createContainer(sessionId, "/tmp", {
        image: "node:22",
        ports: [],
      });

      // Remove
      mockExecSync.mockReturnValueOnce(""); // docker rm -f
      manager.removeContainer(sessionId);

      expect(manager.getContainer(sessionId)).toBeUndefined();
      const rmCall = mockExecSync.mock.calls[2][0] as string;
      expect(rmCall).toContain("docker rm -f");
      expect(rmCall).toContain("cid123");
    });

    it("does nothing for unknown session", () => {
      manager.removeContainer("unknown");
      expect(mockExecSync).not.toHaveBeenCalled();
    });
  });

  describe("cleanupAll", () => {
    it("removes all tracked containers", () => {
      // Create two containers
      mockExecSync.mockReturnValueOnce("cid1");
      mockExecSync.mockReturnValueOnce(""); // start
      manager.createContainer("sess-1", "/tmp", { image: "node:22", ports: [] });

      mockExecSync.mockReturnValueOnce("cid2");
      mockExecSync.mockReturnValueOnce(""); // start
      manager.createContainer("sess-2", "/tmp", { image: "node:22", ports: [] });

      expect(manager.listContainers()).toHaveLength(2);

      // Cleanup
      mockExecSync.mockReturnValueOnce(""); // rm cid1
      mockExecSync.mockReturnValueOnce(""); // rm cid2
      manager.cleanupAll();

      expect(manager.listContainers()).toHaveLength(0);
    });
  });

  describe("port validation", () => {
    it("rejects port 0", () => {
      expect(() =>
        manager.createContainer("sess-1", "/tmp", {
          image: "node:22",
          ports: [0],
        }),
      ).toThrow("Invalid port number: 0");
    });

    it("rejects negative ports", () => {
      expect(() =>
        manager.createContainer("sess-1", "/tmp", {
          image: "node:22",
          ports: [-1],
        }),
      ).toThrow("Invalid port number: -1");
    });

    it("rejects ports above 65535", () => {
      expect(() =>
        manager.createContainer("sess-1", "/tmp", {
          image: "node:22",
          ports: [70000],
        }),
      ).toThrow("Invalid port number: 70000");
    });
  });

  describe("restoreContainer", () => {
    it("restores a running container", () => {
      // docker inspect returns "true" (running)
      mockExecSync.mockReturnValueOnce("true");

      const info: ContainerInfo = {
        containerId: "cid-restore-1",
        name: "companion-restore1",
        image: "companion-dev:latest",
        portMappings: [{ containerPort: 3000, hostPort: 49152 }],
        hostCwd: "/tmp/project",
        containerCwd: "/workspace",
        state: "creating", // will be updated
      };

      const result = manager.restoreContainer("sess-restore", info);

      expect(result).toBe(true);
      expect(manager.getContainer("sess-restore")).toBeDefined();
      expect(manager.getContainer("sess-restore")!.state).toBe("running");
    });

    it("restores a stopped container", () => {
      // docker inspect returns "false" (stopped)
      mockExecSync.mockReturnValueOnce("false");

      const info: ContainerInfo = {
        containerId: "cid-restore-2",
        name: "companion-restore2",
        image: "node:22",
        portMappings: [],
        hostCwd: "/tmp/project",
        containerCwd: "/workspace",
        state: "creating",
      };

      const result = manager.restoreContainer("sess-restore-2", info);

      expect(result).toBe(true);
      expect(manager.getContainer("sess-restore-2")!.state).toBe("stopped");
    });

    it("returns false for non-existent container", () => {
      mockExecSync.mockImplementationOnce(() => {
        throw new Error("No such container");
      });

      const info: ContainerInfo = {
        containerId: "cid-gone",
        name: "companion-gone",
        image: "node:22",
        portMappings: [],
        hostCwd: "/tmp/project",
        containerCwd: "/workspace",
        state: "running",
      };

      const result = manager.restoreContainer("sess-gone", info);

      expect(result).toBe(false);
      expect(manager.getContainer("sess-gone")).toBeUndefined();
    });
  });

  describe("buildImage", () => {
    it("calls docker build with correct args", () => {
      mockExecSync.mockReturnValueOnce("Successfully built abc123");

      const output = manager.buildImage("/path/to/Dockerfile.dev", "my-image:latest");

      expect(output).toBe("Successfully built abc123");
      const buildCall = mockExecSync.mock.calls[0][0] as string;
      expect(buildCall).toContain("docker build");
      expect(buildCall).toContain("-t my-image:latest");
      expect(buildCall).toContain("-f /path/to/Dockerfile.dev");
    });

    it("throws on build failure", () => {
      mockExecSync.mockImplementationOnce(() => {
        throw new Error("build failed: COPY failed");
      });

      expect(() =>
        manager.buildImage("/path/to/Dockerfile.dev"),
      ).toThrow("Failed to build image");
    });
  });
});
