import { describe, expect, it } from "vitest";
import {
  findIndexed,
  hostDebugPath,
  IndexedDee,
  joinPath,
  planLocalFile,
  posixDirname,
  relativeInside,
  workingCopyPath,
  WORKING_COPY_FOLDER,
} from "../src/core/localDees";

const dee = (actionName: string, filePath: string, format: IndexedDee["format"]): IndexedDee => ({ actionName, filePath, format });

describe("relativeInside / joinPath", () => {
  it("returns the /-separated relative path only for files inside the root", () => {
    expect(relativeInside("/ws/proj", "/ws/proj/Cmf.Custom.Data/DEEs/Sub/A.cs")).toBe("Cmf.Custom.Data/DEEs/Sub/A.cs");
    expect(relativeInside("/ws/proj/", "/ws/proj/A.cs")).toBe("A.cs");
    expect(relativeInside("/ws/proj", "/ws/other/A.cs")).toBeUndefined();
    expect(relativeInside("/ws/proj", "/ws/project/A.cs")).toBeUndefined(); // prefix is not containment
    expect(relativeInside("/ws/proj", "/ws/proj")).toBeUndefined();
  });

  it("handles Windows paths case-insensitively and keeps their separator", () => {
    expect(relativeInside("C:\\Repo", "c:\\repo\\Cmf.Custom.Data\\DEEs\\A.cs")).toBe("Cmf.Custom.Data/DEEs/A.cs");
    expect(joinPath("C:\\Repo", ".dee-debug", "A.cs")).toBe("C:\\Repo\\.dee-debug\\A.cs");
    expect(joinPath("/ws/", "a", "b.cs")).toBe("/ws/a/b.cs");
  });
});

describe("planLocalFile (ADR 0012)", () => {
  const root = "/ws/proj";
  const primary = "/ws/proj/Cmf.Custom.Data/DEEs";

  it("uses a generated-format file in place, wherever it lives", () => {
    const plan = planLocalFile("Act", dee("Act", `${primary}/Material/Act.cs`, "generated"), primary, root);
    expect(plan).toEqual({ kind: "inPlace", editPath: `${primary}/Material/Act.cs` });
  });

  it("never edits a DeeDevBase-format file: a working copy under .dee-debug mirrors its path", () => {
    const plan = planLocalFile("Act", dee("Act", `${primary}/Material/Act.cs`, "legacy"), primary, root);
    expect(plan).toEqual({
      kind: "workingCopy",
      sourcePath: `${primary}/Material/Act.cs`,
      editPath: `/ws/proj/${WORKING_COPY_FOLDER}/Cmf.Custom.Data/DEEs/Material/Act.cs`,
    });
  });

  it("creates <primary>/<Name>.cs only when no local file exists", () => {
    expect(planLocalFile("New_One", undefined, primary, root)).toEqual({ kind: "create", editPath: `${primary}/New_One.cs` });
  });

  it("keeps working copies of same-named files in different packages apart", () => {
    const a = workingCopyPath(root, "/ws/proj/Cmf.Custom.Data/DEEs/X.cs");
    const b = workingCopyPath(root, "/ws/proj/Cmf.Custom.Data.Extra/DEEs/X.cs");
    expect(a).not.toBe(b);
    expect(workingCopyPath(root, "/elsewhere/X.cs")).toBe(`/ws/proj/${WORKING_COPY_FOLDER}/_external/X.cs`);
  });
});

describe("hostDebugPath", () => {
  it("mirrors the path relative to the mapped root, so one sourceFileMap entry covers subfolders", () => {
    expect(hostDebugPath("/tmp/CriticalManufacturing/dee-debug", "/ws/proj", "/ws/proj/Cmf.Custom.Data/DEEs/Sub/A.cs")).toBe(
      "/tmp/CriticalManufacturing/dee-debug/Cmf.Custom.Data/DEEs/Sub/A.cs",
    );
    expect(hostDebugPath("/tmp/x/", "C:\\Repo", "C:\\Repo\\.dee-debug\\A.cs")).toBe("/tmp/x/.dee-debug/A.cs");
    expect(hostDebugPath("/tmp/x", "/ws/proj", "/other/A.cs")).toBeUndefined();
    expect(posixDirname("/tmp/x/Cmf.Custom.Data/A.cs")).toBe("/tmp/x/Cmf.Custom.Data");
  });
});

describe("findIndexed", () => {
  it("matches by action name or <Name>.cs file name, and reports duplicates instead of guessing", () => {
    const index = [dee("A", "/p1/DEEs/A.cs", "generated"), dee("B", "/p1/DEEs/sub/B.cs", "legacy"), dee("B", "/p2/DEEs/B.cs", "legacy")];
    expect(findIndexed(index, "A").match?.filePath).toBe("/p1/DEEs/A.cs");
    const b = findIndexed(index, "B");
    expect(b.match).toBeUndefined();
    expect(b.conflicts.map((c) => c.filePath)).toEqual(["/p1/DEEs/sub/B.cs", "/p2/DEEs/B.cs"]);
    expect(findIndexed(index, "Missing")).toEqual({ match: undefined, conflicts: [] });
  });
});
