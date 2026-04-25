import { mkdtemp, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, it } from "vitest"
import { enforceExecutionIntegrity } from "../src/adapters/opencodeAdapter.js"

describe("reliability file-write smoke", () => {
  it("fails when file mutation is claimed without side effects", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bridge-smoke-"))

    await expect(
      enforceExecutionIntegrity(
        {
          success: true,
          response: "ok",
          model: "m",
          mode: "reactive",
          used_tools: ["create_file"],
          created_paths: [],
          updated_paths: [],
        },
        root,
      ),
    ).rejects.toThrow("file_mutation_without_side_effects")
  })

  it("fails when paths are reported but no file exists", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bridge-smoke-"))

    await expect(
      enforceExecutionIntegrity(
        {
          success: true,
          response: "ok",
          model: "m",
          mode: "reactive",
          used_tools: ["apply_patch"],
          created_paths: ["missing.txt"],
          updated_paths: [],
        },
        root,
      ),
    ).rejects.toThrow("file_mutation_evidence_missing")
  })

  it("passes when file mutation has actual side effect evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bridge-smoke-"))
    const filePath = path.join(root, "written.txt")
    await writeFile(filePath, "content", "utf-8")

    await expect(
      enforceExecutionIntegrity(
        {
          success: true,
          response: "ok",
          model: "m",
          mode: "reactive",
          used_tools: ["create_file"],
          created_paths: ["written.txt"],
          updated_paths: [],
        },
        root,
      ),
    ).resolves.toBeUndefined()
  })
})
