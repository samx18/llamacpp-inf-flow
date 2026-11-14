/**
 * Trace event schema shared by the native tracer (engine/tracer.cpp) and the web player.
 *
 * The trace is newline-delimited JSON: one TraceEvent per line, written by the tracer to stdout.
 * This file is the single source of truth. `trace.schema.json` is generated from it
 * (`npm run schema` in web/) and the tracer's output is validated against that file
 * (`node scripts/validate-trace.mjs <trace.jsonl>`).
 *
 * Conventions
 * - `step` 0 is the prefill decode (and the prelude events before it); step k >= 1 decodes the
 *   token chosen in step k-1. The sampling events of step k choose the token decoded in step k+1.
 * - `t_us` is microseconds since the tracer started (ggml_time_us).
 * - Floats that are not finite (masked logits, -inf after greedy temp) are written as null.
 * - Every value comes from llama.cpp through its public API (llama.h, ggml headers, cb_eval).
 */

/** @asType integer */
export type Int = number;

/** A float as produced by llama.cpp; null when it was NaN or +/-Inf. */
export type Float = number | null;

/** ggml tensor shape, ne[0..3] (ne[0] is the fastest-moving dimension). */
export type Shape = [Int, Int, Int, Int];

/** A location in the pinned llama.cpp source (read from it at build time by scripts/gen-sources.py) */
export interface SrcLoc {
  /** Function name, for stage functions */
  fn?: string;
  /** Path relative to the llama.cpp repo root */
  file: string;
  line: Int;
  /** GitHub link at the pinned commit */
  url: string;
}

export interface EventBase {
  type: string;
  /** @minimum 0 */
  step: Int;
  /** Microseconds since tracer start. @minimum 0 */
  t_us: Int;
}

// ---------------------------------------------------------------------------------------------
// Prelude

export interface ModelInfoEvent extends EventBase {
  type: 'model_info';
  /** GGUF general.architecture */
  arch: string;
  /** GGUF general.name, if present */
  name: string | null;
  /** llama_model_desc */
  desc: string;
  /** llama_model_n_layer */
  n_layer: Int;
  /** llama_model_n_embd */
  n_embd: Int;
  /** llama_model_n_head */
  n_head: Int;
  /** llama_model_n_head_kv */
  n_head_kv: Int;
  /** GGUF <arch>.attention.key_length if present, else n_embd / n_head as computed by the tracer */
  n_embd_head: Int;
  /** GGUF <arch>.feed_forward_length, if present */
  n_ff: Int | null;
  /** llama_vocab_n_tokens */
  n_vocab: Int;
  /** llama_vocab_type: name of the enum value (SPM, BPE, ...) */
  vocab_type: string;
  /** llama_model_n_ctx_train */
  n_ctx_train: Int;
  /** llama_n_ctx of the context the tracer created */
  n_ctx: Int;
  /** llama_n_batch / llama_n_ubatch of the context */
  n_batch: Int;
  n_ubatch: Int;
  /** llama_model_n_params */
  n_params: Int;
  /** llama_model_size: bytes of all tensors */
  model_size: Int;
  /** Size of the GGUF file on disk, bytes */
  file_size: Int;
  file_name: string;
  bos_id: Int | null;
  eos_id: Int | null;
  /** Every GGUF metadata key/value pair as llama_model_meta_val_str_by_index renders it */
  meta: Record<string, string>;
  /** llama_token_to_piece(special=true) for every token id, invalid UTF-8 replaced with U+FFFD */
  vocab: string[];
  /**
   * Definitions of the llama.cpp / ggml functions behind each stage. Keys: tokenize,
   * token_to_piece, vocab_is_eog, batch_init, decode, process_ubatch, build_graph, graph_compute,
   * sched_compute, sched_splits, memory_pos_max, get_logits_ith, sampler_apply, sampler_accept,
   * sampler_<llama_sampler_name> (e.g. sampler_top-k), and arch_graph when the architecture's
   * graph builder was found.
   */
  sources: Record<string, SrcLoc>;
  llama_cpp: { commit: string; commit_full: string; tag: string | null };
  /** llama_print_system_info */
  system_info: string;
  settings: TracerSettings;
}

export interface TracerSettings {
  prompt: string;
  /** @minimum 0 */
  n_predict: Int;
  seed: Int;
  /** 'greedy' uses llama_sampler_init_greedy only; 'dist' runs top-k, top-p, temp, dist. */
  sampling: 'greedy' | 'dist';
  top_k: Int;
  top_p: number;
  temp: number;
  n_threads: Int;
  flash_attn: boolean;
  /** Names of the captured tensors whose values ship in full (base names, layer suffix stripped) */
  capture: string[];
  graph_reuse_disabled: boolean;
  /** --force: token ids that replace the sampled token at steps 0..n-1 (fork from a token) */
  force: Int[];
}

export interface TokenInfo {
  id: Int;
  /** llama_token_to_piece(special=true); invalid UTF-8 bytes replaced with U+FFFD */
  piece: string;
  /** The raw piece bytes, hex encoded */
  piece_hex: string;
  /** Byte span [start, end) in the prompt, from cumulative llama_detokenize; null if not mappable.
   *  A token that only renders the tokenizer's added space prefix, or BOS, has an empty span. */
  start: Int | null;
  end: Int | null;
  /** llama_vocab_is_control */
  special: boolean;
  /** llama_vocab_get_attr bit field */
  attr: Int;
}

export interface TokenizeEvent extends EventBase {
  type: 'tokenize';
  prompt: string;
  /** Prompt length in bytes (UTF-8) */
  prompt_bytes: Int;
  /**
   * llama_detokenize of all prompt tokens. For SPM vocabularies this is the prompt with the
   * space prefix the tokenizer added; token spans are relative to `prompt`, not to this string.
   */
  detokenized: string;
  add_special: boolean;
  parse_special: boolean;
  /** Wall time of the llama_tokenize call */
  dur_us: Int;
  tokens: TokenInfo[];
}

// ---------------------------------------------------------------------------------------------
// Per decode

export interface BatchRow {
  token: Int;
  pos: Int;
  seq_id: Int[];
  /** llama_batch.logits flag for this row */
  logits: boolean;
}

export interface BatchEvent extends EventBase {
  type: 'batch';
  n_tokens: Int;
  /** llama_memory_seq_pos_max(mem, 0) before this decode; -1 when the cache is empty */
  kv_pos_max_before: Int;
  rows: BatchRow[];
}

export type NodeKind =
  /** a graph node computed by an op */
  | 'op'
  /** a leaf in a weights buffer (GGML_BACKEND_BUFFER_USAGE_WEIGHTS) */
  | 'weight'
  /** a leaf flagged GGML_TENSOR_FLAG_INPUT (inp_tokens, inp_pos, kq_mask, ...) */
  | 'input'
  /** a leaf whose name starts with cache_k_ / cache_v_ (llama KV cache storage) */
  | 'kv_cache'
  /** any other leaf */
  | 'leaf';

export interface GraphNode {
  /** Graph nodes: execution index 0..n_nodes-1. Leaves: n_nodes and up. */
  id: Int;
  kind: NodeKind;
  /** ggml_op_desc (unary ops show their unary name) */
  op: string;
  /** ggml_get_name, as set by llama.cpp (e.g. "attn_out-3", "Qcur-0 (view)") */
  name: string;
  /** name with ggml's " (view)", " (permuted)", ... suffixes and the "-N" layer suffix removed */
  base: string;
  /** Layer from the "-N" name suffix or "blk.N." / "cache_*_lN" prefix; null for whole-model tensors */
  layer: Int | null;
  /**
   * Nodes with a generic name ("node_12", "(view)") are attached to the first named node
   * downstream: `group` is that node's id. Named nodes and leaves have group == id.
   */
  group: Int;
  /**
   * Block (id of its anchor node) in the block view. Anchors are op nodes named exactly embd,
   * attn_out-N, ffn_out-N, l_out-N, result_norm, result_output. Leaves take their first consumer's block.
   */
  block: Int | null;
  shape: Shape;
  /** ggml_type_name */
  dtype: string;
  is_weight: boolean;
  /** GGML_TENSOR_FLAG_COMPUTE: false for branches of ggml_build_forward_select that are not taken */
  computed: boolean;
  /** GGML_TENSOR_FLAG_INPUT / GGML_TENSOR_FLAG_OUTPUT */
  is_input: boolean;
  is_output: boolean;
  /** Source lines that assign this tensor name (cb / ggml_set_name / ggml_format_name), up to 3 */
  named_at: SrcLoc[];
}

export interface GraphBlock {
  /** Anchor node id */
  id: Int;
  name: string;
  base: string;
  layer: Int | null;
  n_ops: Int;
  n_leaves: Int;
  /** First and last op node id in the block */
  first: Int;
  last: Int;
}

export interface GraphEvent extends EventBase {
  type: 'graph';
  /**
   * true when llama.cpp reused the previous graph (llama_perf_context().n_reused increased
   * during this decode). Reused graphs carry no node list; the player keeps the previous one.
   */
  reused: boolean;
  /** Counter of built graphs; a reused graph repeats the id of the graph it reuses */
  graph_id: Int;
  /** Number of graph nodes visited by the scheduler callback (leaves excluded) */
  n_nodes: Int;
  /** Number of leaves referenced through src[] (weights, inputs, KV cache) */
  n_leafs: Int;
  nodes?: GraphNode[];
  /** [from, to] node ids, one per non-null src[] slot of each graph node, in src order */
  edges?: [Int, Int][];
  /** Blocks in execution order (absent on reused graphs) */
  blocks?: GraphBlock[];
}

export interface TensorStats {
  /** min / max / mean over finite elements; null when there are none */
  min: Float;
  max: Float;
  mean: Float;
  n_nan: Int;
  n_pos_inf: Int;
  n_neg_inf: Int;
}

export interface NodeExecEvent extends EventBase {
  type: 'node_exec';
  id: Int;
  /** Order in which the scheduler computed this node in this decode, 0-based */
  seq: Int;
  /** Wall time from the cb_eval ask==true return to the ask==false call: one-node compute + sync */
  dur_us: Int;
  computed: boolean;
  /** Absent for nodes that were not computed or have a non-numeric type */
  stats?: TensorStats;
  /** Full values in ggml element order (ne[0] fastest), only for captured tensors */
  values?: Float[];
}

export interface DecodeEndEvent extends EventBase {
  type: 'decode_end';
  /** llama_decode return code */
  ret: Int;
  /** Wall time of llama_decode, including tracer callback overhead */
  dur_us: Int;
  /** Sum of node_exec dur_us for this decode */
  compute_us: Int;
  /** llama_memory_seq_pos_max(mem, 0) after decode */
  kv_pos_max: Int;
  /** llama_memory_seq_pos_min(mem, 0) after decode */
  kv_pos_min: Int;
  n_nodes: Int;
  n_computed: Int;
  /**
   * KV cache cell written for each batch row, in row order: the row-index input (src[1]) of the
   * first SET_ROWS into a cache_k_* tensor. Attention (kq_soft_max) columns index these cells.
   */
  kv_cells: Int[];
  reused: boolean;
  graph_id: Int;
  /** Sum of node_exec dur_us per ggml op (ggml_op_desc), largest first */
  op_time_us: { op: string; us: Int; n: Int }[];
  /** Sum of node_exec dur_us per block, in block order */
  block_time_us: { block: Int; us: Int }[];
}

export interface LogitsEvent extends EventBase {
  type: 'logits';
  /** Batch index passed to llama_get_logits_ith (-1: last output) */
  idx: Int;
  /** One per vocab entry */
  values: Float[];
}

export interface Candidate {
  id: Int;
  logit: Float;
  /** llama_token_data.p as the sampler left it (top-k does not write p; temp does not update it) */
  p: Float;
}

export interface SamplerStageEvent extends EventBase {
  type: 'sampler_stage';
  /** Position in the sampler sequence, 0-based */
  index: Int;
  /** llama_sampler_name */
  name: string;
  params: Record<string, number>;
  dur_us: Int;
  /** llama_token_data_array.sorted / .selected after this sampler */
  sorted: boolean;
  selected: Int;
  /** llama_token_data_array.size after this sampler */
  size: Int;
  /** Candidates in array order after this sampler (size == llama_token_data_array.size) */
  candidates: Candidate[];
}

export interface TokenSelectedEvent extends EventBase {
  type: 'token_selected';
  id: Int;
  piece: string;
  piece_hex: string;
  /** p of the selected candidate as left by the last sampler (dist normalises it; greedy leaves 0) */
  p: Float;
  logit: Float;
  /** Index of the selected entry in the final candidate array (-1 if forced and not present) */
  selected: Int;
  /** true when the token came from --force rather than the sampler */
  forced: boolean;
  /** llama_vocab_is_eog */
  is_eog: boolean;
  /** 1-based count of generated tokens */
  n_generated: Int;
}

export interface DoneEvent extends EventBase {
  type: 'done';
  reason: 'eog' | 'n_predict' | 'error';
  error?: string;
  n_prompt: Int;
  n_generated: Int;
  n_decode: Int;
  n_graphs_built: Int;
  n_graphs_reused: Int;
  /** Generated text: concatenated pieces of the selected tokens */
  text: string;
  totals_us: {
    load: Int;
    tokenize: Int;
    prefill: Int;
    decode: Int;
    sample: Int;
    total: Int;
  };
  /** llama_perf_context as reported by llama.cpp */
  perf: {
    t_load_ms: number;
    t_p_eval_ms: number;
    t_eval_ms: number;
    n_p_eval: Int;
    n_eval: Int;
    n_reused: Int;
  };
}

export type TraceEvent =
  | ModelInfoEvent
  | TokenizeEvent
  | BatchEvent
  | GraphEvent
  | NodeExecEvent
  | DecodeEndEvent
  | LogitsEvent
  | SamplerStageEvent
  | TokenSelectedEvent
  | DoneEvent;

export type TraceEventType = TraceEvent['type'];
