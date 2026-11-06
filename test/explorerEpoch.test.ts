import { describe, expect, it } from "vitest";
import { __reset } from "./mocks/vscode";
import { DeeExplorerProvider } from "../src/vscode/explorer";
import { SessionStore } from "../src/vscode/session";
import { MesClient } from "../src/core/mesClient";

/** M3 regression: a stale (slow) refresh must never repaint over a newer one. */
describe("DeeExplorerProvider refresh epoch (M3)", () => {
  it("discards the completion of a superseded refresh", async () => {
    __reset();
    const sessions = new SessionStore();
    let call = 0;
    const resolvers: ((v: never[]) => void)[] = [];
    const client = {
      getAllActionGroups: () => new Promise((resolve) => resolvers.push(resolve as never)),
      getAllActions: async () => {
        call++;
        return call === 1
          ? [{ Name: "from-env-A", IsEnabled: true, UniversalState: 3 }]
          : [{ Name: "from-env-B", IsEnabled: true, UniversalState: 3 }];
      },
    } as unknown as MesClient;
    const provider = new DeeExplorerProvider(() => client, () => false, sessions);

    const first = provider.refresh(); // slow: groups promise unresolved
    const second = provider.refresh(); // newer refresh
    resolvers[1]!([]); // second completes first
    await second;
    expect(provider.allActions().map((r) => r.action.Name)).toEqual(["from-env-B"]);

    resolvers[0]!([]); // the stale first completes afterwards
    await first;
    // Stale completion must NOT repaint env A's data.
    expect(provider.allActions().map((r) => r.action.Name)).toEqual(["from-env-B"]);
  });
});
