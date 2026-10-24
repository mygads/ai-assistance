// Memory domain: scoped, provenanced, versioned items with contamination guards.
// Core invariant: AI suggestions, other people's speech, and reading a
// suggestion aloud NEVER promote text to a confirmed personal fact.
// Only explicit user correction/confirmation (or curated import with evidence)
// creates confirmed facts. Conflicts supersede; nothing is silently overwritten.

export type MemoryScope = "profile" | "workspace" | "session" | "episodic";
export type MemoryKind = "fact" | "preference" | "correction" | "summary" | "playbook";
export type MemoryStatus = "draft" | "confirmed" | "superseded";

export interface MemoryItem {
  id: string;
  scope: MemoryScope;
  workspace_id: string | null;
  session_id: string | null;
  kind: MemoryKind;
  text: string;
  status: MemoryStatus;
  source_refs: string[];
  supersedes: string | null;
  created_at: string;
  version: number;
}

export type EvidenceKind = "user_correction" | "user_confirmation" | "curated_import" | "session_summary" | "ai_suggestion" | "remote_speech" | "read_aloud";

const CONFIRMING: ReadonlySet<EvidenceKind> = new Set(["user_correction", "user_confirmation", "curated_import"]);

export interface ProposeInput {
  id: string;
  scope: MemoryScope;
  workspace_id: string | null;
  session_id: string | null;
  kind: MemoryKind;
  text: string;
  evidence: EvidenceKind;
  source_refs: string[];
  created_at: string;
}

export class MemoryStore {
  private items = new Map<string, MemoryItem>();

  /** Propose a memory. Non-confirming evidence yields draft at best; suggestions/remote/read-aloud can never confirm. */
  propose(input: ProposeInput): { item: MemoryItem; promoted: boolean } {
    const confirming = CONFIRMING.has(input.evidence);
    const status: MemoryStatus = confirming ? "confirmed" : "draft";
    const item: MemoryItem = {
      id: input.id,
      scope: input.scope,
      workspace_id: input.workspace_id,
      session_id: input.session_id,
      kind: input.kind,
      text: input.text,
      status,
      source_refs: [...input.source_refs],
      supersedes: null,
      created_at: input.created_at,
      version: 1,
    };
    this.items.set(item.id, item);
    return { item, promoted: confirming };
  }

  /** Explicit user correction supersedes a conflicting item; the old version is retained. */
  correct(oldId: string, input: Omit<ProposeInput, "evidence"> & { evidence: "user_correction" | "user_confirmation" }): MemoryItem | null {
    const old = this.items.get(oldId);
    if (!old) return null;
    const next: MemoryItem = {
      id: input.id,
      scope: old.scope,
      workspace_id: old.workspace_id,
      session_id: input.session_id ?? old.session_id,
      kind: old.kind,
      text: input.text,
      status: "confirmed",
      source_refs: [...input.source_refs],
      supersedes: old.id,
      created_at: input.created_at,
      version: old.version + 1,
    };
    old.status = "superseded";
    this.items.set(next.id, next);
    return next;
  }

  /** Roll back to a superseded version: re-confirm the old content as a new version. */
  rollback(oldId: string, newId: string, created_at: string): MemoryItem | null {
    const old = this.items.get(oldId);
    if (!old || old.status !== "superseded") return null;
    const next: MemoryItem = {
      ...old,
      id: newId,
      status: "confirmed",
      supersedes: old.supersedes,
      created_at,
      version: old.version + 1,
    };
    this.items.set(next.id, next);
    return next;
  }

  /** Recall is always scoped: profile + selected workspace + session. Nothing leaks across workspaces. */
  recall(opts: { workspace_id: string | null; session_id: string | null; include_drafts: boolean }): MemoryItem[] {
    return [...this.items.values()].filter((m) => {
      if (!opts.include_drafts && m.status !== "confirmed") return false;
      if (m.status === "superseded") return false;
      if (m.scope === "profile") return true;
      if (m.scope === "workspace") return m.workspace_id === opts.workspace_id;
      if (m.scope === "session" || m.scope === "episodic") {
        return m.workspace_id === opts.workspace_id && (m.session_id === opts.session_id || m.scope === "episodic");
      }
      return false;
    });
  }

  get(id: string): MemoryItem | undefined {
    return this.items.get(id);
  }
}
