// Context budget: assemble a context packet within a model's real limits.
// Token counts here are heuristic estimates (chars/4); the margin absorbs the
// gap to the provider's tokenizer. Budgets come from the active model profile,
// never from a hardcoded "always fits" assumption.

export interface ModelProfile {
  id: string;
  provider: string;
  model: string;
  context_limit: number;
  input_limit: number;
  output_limit: number;
  streaming: boolean;
}

export interface ContextItem {
  id: string;
  /** pinned_brief | pinned_fact | document_full | retrieved_section | history | correction */
  kind: string;
  text: string;
  source_refs: string[];
  priority: number;
}

export interface ContextPacket {
  id: string;
  model_profile_id: string;
  items: ContextItem[];
  dropped_item_ids: string[];
  estimated_input_tokens: number;
  reserved_output_tokens: number;
  budget_input_tokens: number;
}

/** Heuristic estimator. Labeled as such everywhere it is used. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const UNCERTAINTY_MARGIN = 0.85;

export function buildContextPacket(
  id: string,
  profile: ModelProfile,
  items: ContextItem[],
  opts: { activeContextTarget?: number } = {},
): ContextPacket {
  const reserve = Math.min(profile.output_limit, Math.max(1024, Math.floor(profile.input_limit * 0.1)));
  const hardBudget = Math.min(profile.input_limit, profile.context_limit - reserve);
  const softTarget = Math.min(opts.activeContextTarget ?? 30000, hardBudget);
  const budget = Math.floor(Math.min(hardBudget, softTarget) * UNCERTAINTY_MARGIN);

  const ordered = [...items].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  const kept: ContextItem[] = [];
  const dropped: string[] = [];
  let used = 0;
  for (const item of ordered) {
    const cost = estimateTokens(item.text);
    // Pinned briefs/facts and corrections always fit: they outrank raw history.
    const mustKeep = item.kind === "pinned_brief" || item.kind === "pinned_fact" || item.kind === "correction";
    if (mustKeep || used + cost <= budget) {
      kept.push(item);
      used += cost;
    } else {
      dropped.push(item.id);
    }
  }
  return {
    id,
    model_profile_id: profile.id,
    items: kept,
    dropped_item_ids: dropped,
    estimated_input_tokens: used,
    reserved_output_tokens: reserve,
    budget_input_tokens: budget,
  };
}

/** Repack the same source items for a different model (e.g. after a switch). */
export function repackForModel(packet: ContextPacket, allItems: ContextItem[], profile: ModelProfile): ContextPacket {
  const byId = new Map(allItems.map((i) => [i.id, i]));
  const sources = [...packet.items, ...packet.dropped_item_ids.map((id) => byId.get(id)).filter((i) => i !== undefined)];
  return buildContextPacket(`${packet.id}-repacked-${profile.id}`, profile, sources);
}

/** Kinds whose source_refs must resolve to imported workspace documents. */
const DOCUMENT_KINDS = new Set(["document_full", "retrieved_section"]);

export interface SourceRefValidation {
  ok: boolean;
  /** Refs naming documents that were never imported into the workspace. */
  dangling: string[];
  /** Document-kind item ids carried with no source at all. */
  missingSource: string[];
}

/**
 * T09: every citation in a context packet must resolve to an actually-imported
 * document. `knownDocIds` is the workspace's imported document id set (e.g.
 * from the accumulated import_document results). Non-document kinds (history,
 * pinned briefs/facts, corrections) carry segment or memory refs, not
 * document refs, so their source_refs are out of scope here.
 */
export function validateSourceRefs(items: ContextItem[], knownDocIds: Iterable<string>): SourceRefValidation {
  const known = new Set(knownDocIds);
  const dangling: string[] = [];
  const missingSource: string[] = [];
  for (const item of items) {
    if (!DOCUMENT_KINDS.has(item.kind)) continue;
    if (item.source_refs.length === 0) {
      missingSource.push(item.id);
      continue;
    }
    for (const ref of item.source_refs) {
      if (!known.has(ref) && !dangling.includes(ref)) dangling.push(ref);
    }
  }
  return { ok: dangling.length === 0 && missingSource.length === 0, dangling, missingSource };
}
