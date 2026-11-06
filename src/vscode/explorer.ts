import * as vscode from "vscode";
import { ActionRef, ActionTree, buildActionTree, GroupNode } from "../core/treeModel";
import { draftExecutionNote, isDraftVersion, stateName } from "../core/actionVersions";
import { DeeAction, DeeActionGroup } from "../core/types";
import { MesClient } from "../core/mesClient";
import { SessionStore } from "./session";

/** Informational row shown above the hierarchy (connection state, filter count). */
export interface InfoNode {
  info: string;
  id: string;
  tooltip?: string;
  icon?: string;
  iconColor?: string;
  command?: string;
}

export type DeeTreeNode = GroupNode | ActionRef | InfoNode;

function isAction(node: DeeTreeNode): node is ActionRef {
  return (node as ActionRef).action !== undefined;
}

function isInfo(node: DeeTreeNode): node is InfoNode {
  return (node as InfoNode).info !== undefined;
}

/** Actions under a group node, including every sub-group. */
export function countActions(node: GroupNode): number {
  return node.actions.length + node.groups.reduce((sum, child) => sum + countActions(child), 0);
}

export class DeeExplorerProvider implements vscode.TreeDataProvider<DeeTreeNode> {
  private readonly emitter = new vscode.EventEmitter<DeeTreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private tree: ActionTree | undefined;
  private groups: DeeActionGroup[] = [];
  private actions: DeeAction[] = [];
  private loaded = false;
  private filter: string | undefined;
  private view: vscode.TreeView<DeeTreeNode> | undefined;
  /** Bumps group item ids so VS Code re-applies their default collapsed state. */
  private expandGeneration = 0;
  private expandNextRender = false;

  constructor(
    private readonly getClient: () => MesClient,
    private readonly getShowDisabled: () => boolean,
    private readonly sessions: SessionStore,
    private readonly getEnvName: () => string | undefined = () => undefined,
  ) {
    sessions.onDidChange(() => this.emitter.fire(undefined));
  }

  attachView(view: vscode.TreeView<DeeTreeNode>): void {
    this.view = view;
  }

  private refreshEpoch = 0;
  private readonly refreshEmitter = new vscode.EventEmitter<DeeAction[]>();
  /** Fires with the fetched actions after every successful refresh (R5 reconciliation). */
  readonly onDidRefresh = this.refreshEmitter.event;

  /**
   * Reload from the server. Throws on failure (caller shows the error). Epoch-guarded
   * (M3): when refreshes overlap — e.g. an environment switch while a slow request is
   * in flight — only the newest completion may paint the tree; stale ones are dropped.
   */
  async refresh(): Promise<void> {
    const epoch = ++this.refreshEpoch;
    const client = this.getClient();
    try {
      const [groups, actions] = await Promise.all([client.getAllActionGroups(), client.getAllActions()]);
      if (epoch !== this.refreshEpoch) return; // a newer refresh superseded this one
      [this.groups, this.actions] = [groups, actions];
      this.loaded = true;
      this.rebuild();
      this.refreshEmitter.fire(actions);
    } catch (error) {
      if (epoch !== this.refreshEpoch) return; // stale failure — newer state stands
      this.loaded = false;
      this.tree = undefined;
      this.rebuild(); // keeps the env/filter header and badge accurate even when unloaded
      throw error;
    }
  }

  /** Rebuild the tree from the cached fetch (no server round-trip). */
  rebuild(): void {
    if (this.loaded) {
      this.tree = buildActionTree(this.groups, this.actions, {
        includeDisabled: this.getShowDisabled(),
        search: this.filter,
      });
    }
    // Drives the title-bar icon swap ($(filter) ↔ $(filter-filled)) via the menu `when` clauses.
    void vscode.commands.executeCommand("setContext", "deeDebugger.filterActive", !!this.filter);
    if (this.view) {
      const env = this.getEnvName();
      // The match count lives next to the filter text (menu icons cannot carry badges);
      // the filled filter icon in the title bar signals the active state.
      const matches = this.tree ? this.tree.actionsByName.size : 0;
      const parts = [env, this.filter && `filter: ${this.filter} (${matches})`].filter(Boolean);
      this.view.description = parts.length > 0 ? parts.join(" · ") : undefined;
      this.view.badge = undefined;
    }
    this.emitter.fire(undefined);
  }

  /** One-shot expand of every group (id bump forces VS Code to drop remembered state). */
  expandAll(): void {
    this.expandGeneration++;
    this.expandNextRender = true;
    this.emitter.fire(undefined);
    setTimeout(() => (this.expandNextRender = false), 1500);
  }

  setFilter(filter: string | undefined): void {
    this.filter = filter?.trim() || undefined;
    this.rebuild();
  }

  get currentFilter(): string | undefined {
    return this.filter;
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  findAction(name: string): ActionRef | undefined {
    return this.tree?.actionsByName.get(name);
  }

  allActions(): ActionRef[] {
    return this.tree ? [...this.tree.actionsByName.values()] : [];
  }

  /** Every action row the host returned on the last refresh, before any filtering. */
  rawActions(): DeeAction[] {
    return this.actions;
  }

  getChildren(node?: DeeTreeNode): DeeTreeNode[] {
    if (!node) {
      if (!this.tree) return [];
      const infoRows: InfoNode[] = [
        {
          id: "info:connection",
          info: `Connected · ${this.getEnvName() ?? "MES"}`,
          tooltip: "The DEE Explorer is connected to this environment. Click to switch.",
          icon: "plug",
          iconColor: "testing.iconPassed",
          command: "deeDebugger.switchEnvironment",
        },
      ];
      if (this.filter) {
        const matches = this.tree.actionsByName.size;
        infoRows.push({
          id: "info:filter",
          info: `${matches} DEE${matches === 1 ? "" : "s"} matched '${this.filter}'`,
          tooltip: "Click to change the filter (empty input clears it).",
          icon: "filter",
          command: "deeDebugger.searchActions",
        });
      }
      // GitHub #7: never hide actions silently — say how many are hidden and offer to show them.
      if (this.tree.hiddenDisabled > 0) {
        const n = this.tree.hiddenDisabled;
        infoRows.push({
          id: "info:hidden-disabled",
          info: `${n} disabled action${n === 1 ? "" : "s"} hidden — click to show`,
          tooltip: "Disabled actions are hidden by default (deeDebugger.showDisabledActions). Click to toggle.",
          icon: "eye-closed",
          command: "deeDebugger.toggleShowDisabledActions",
        });
      }
      return [...infoRows, ...this.tree.root.groups, ...this.tree.root.actions];
    }
    if (isAction(node) || isInfo(node)) return [];
    return [...node.groups, ...node.actions];
  }

  getTreeItem(node: DeeTreeNode): vscode.TreeItem {
    if (isInfo(node)) {
      const item = new vscode.TreeItem(node.info, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon(
        node.icon ?? "info",
        node.iconColor ? new vscode.ThemeColor(node.iconColor) : undefined,
      );
      item.tooltip = node.tooltip;
      item.id = node.id;
      if (node.command) item.command = { command: node.command, title: node.info };
      return item;
    }
    if (!isAction(node)) {
      const item = new vscode.TreeItem(
        node.name,
        this.filter || this.expandNextRender
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.contextValue = "deeGroup";
      item.iconPath = new vscode.ThemeIcon("folder");
      // UX: the number of actions below this node answers "is there anything in here?"
      // without expanding — the tree can hold hundreds of extension-point groups.
      const count = countActions(node);
      item.description = count > 0 ? String(count) : undefined;
      item.tooltip = `${node.fullName}\n${count} action${count === 1 ? "" : "s"} in this group and its sub-groups`;
      item.id = `group:${node.fullName}:${this.expandGeneration}`;
      return item;
    }
    const action = node.action;
    const session = this.sessions.get(action.Name);
    const item = new vscode.TreeItem(action.Name, vscode.TreeItemCollapsibleState.None);
    // Unique per (group, action) so a multi-group action renders as distinct tree
    // elements (M4 — TreeView element-uniqueness contract); the expandGeneration suffix
    // matches the group ids so expand-all resets remembered state consistently.
    item.id = `action:${node.groupPath ?? ""}:${action.Name}:${this.expandGeneration}`;
    // A draft row (GitHub #7): the action has no effective version, so this highest version
    // is what the MES runs — the context value exposes "Make Version Effective" for it.
    const draft = isDraftVersion(action);
    item.contextValue = `deeAction${session?.debugOn ? "-debug" : ""}${draft ? "-draft" : ""}`;
    // Badge order = what the user must act on first: live debug state, unsaved work,
    // lifecycle warnings, then the static version number.
    const badges: string[] = [];
    if (session?.debugOn) badges.push("DEBUG");
    if (session?.pendingUpload) badges.push("pending upload");
    if (draft) badges.push(`not effective (${stateName(action.UniversalState)})`);
    if (action.IsEnabled === false) badges.push("disabled");
    if (action.Version !== undefined) badges.push(`v${action.Version}`);
    item.description = badges.join(" · ");
    item.iconPath = session?.debugOn
      ? new vscode.ThemeIcon("debug", new vscode.ThemeColor("debugIcon.startForeground"))
      : draft
        ? new vscode.ThemeIcon("symbol-method", new vscode.ThemeColor("list.warningForeground"))
        : new vscode.ThemeIcon("symbol-method");
    item.tooltip = new vscode.MarkdownString(
      [
        `**${action.Name}**`,
        action.Description ? `\n\n${action.Description}` : "",
        `\n\n- Enabled: ${action.IsEnabled ?? "?"}`,
        `- Version: ${action.Version ?? "?"} (${stateName(action.UniversalState)})`,
        draft
          ? `- **Not effective** — ${draftExecutionNote(action.Version, undefined)}`
          : "",
        action.Classification ? `- Classification: ${action.Classification}` : "",
        session?.debugOn ? `- **Debug mode: ON** (per-user, in-memory)` : "",
        action.ModifiedBy ? `- Modified: ${action.ModifiedOn ?? ""} by ${action.ModifiedBy}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    item.command = { command: "deeDebugger.openAction", title: "Open DEE Action", arguments: [node] };
    return item;
  }
}
