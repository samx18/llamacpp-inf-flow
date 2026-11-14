// tracer: run one llama.cpp generation and write every stage as newline-delimited JSON events.
//
//   tracer --model m.gguf --prompt "Once upon a time" --seed 1 --n-predict 12 > trace.jsonl
//
// Public API only: llama.h, ggml headers and the cb_eval scheduler callback. llama.cpp is not
// modified. stdout carries nothing but events; llama.cpp logs go to stderr (errors only unless
// --verbose). The event schema is web/src/trace/schema.ts.

#include "ggml.h"
#include "ggml-backend.h"
#include "llama.h"

#include <sys/stat.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <set>
#include <string>
#include <unordered_map>
#include <vector>

#ifndef LLAMACPP_COMMIT
#define LLAMACPP_COMMIT "unknown"
#endif
#ifndef LLAMACPP_TAG
#define LLAMACPP_TAG ""
#endif

// ---------------------------------------------------------------------------------------------
// JSON output

static int64_t g_t0 = 0;
static int64_t now_us() { return ggml_time_us() - g_t0; }

// Replace invalid UTF-8 sequences with U+FFFD so every event is valid JSON text.
static std::string sanitize_utf8(const std::string & s) {
    std::string out;
    const auto * p = (const unsigned char *) s.data();
    size_t i = 0, n = s.size();
    while (i < n) {
        unsigned char c = p[i];
        int len = c < 0x80 ? 1 : (c >> 5) == 0x6 ? 2 : (c >> 4) == 0xE ? 3 : (c >> 3) == 0x1E ? 4 : 0;
        bool ok = len > 0 && i + len <= n;
        for (int k = 1; ok && k < len; k++) ok = (p[i + k] >> 6) == 0x2;
        if (ok) {
            out.append(s, i, len);
            i += len;
        } else {
            out += "\xEF\xBF\xBD";
            i += 1;
        }
    }
    return out;
}

static std::string hex(const std::string & s) {
    static const char * d = "0123456789abcdef";
    std::string out;
    for (unsigned char c : s) { out += d[c >> 4]; out += d[c & 15]; }
    return out;
}

struct Json {
    std::string b;
    bool first = true;

    void sep() { if (!first) b += ','; first = false; }
    void key(const char * k) { sep(); str_raw(k); b += ':'; first = true; }

    void str_raw(const std::string & s) {
        b += '"';
        for (unsigned char c : s) {
            switch (c) {
                case '"':  b += "\\\""; break;
                case '\\': b += "\\\\"; break;
                case '\n': b += "\\n";  break;
                case '\r': b += "\\r";  break;
                case '\t': b += "\\t";  break;
                default:
                    if (c < 0x20) { char t[8]; snprintf(t, sizeof t, "\\u%04x", c); b += t; }
                    else b += (char) c;
            }
        }
        b += '"';
    }

    Json & obj()  { sep(); b += '{'; first = true; return *this; }
    Json & end()  { b += '}'; first = false; return *this; }
    Json & arr()  { sep(); b += '['; first = true; return *this; }
    Json & aend() { b += ']'; first = false; return *this; }

    Json & k(const char * name) { key(name); return *this; }
    Json & s(const std::string & v) { sep(); str_raw(sanitize_utf8(v)); return *this; }
    Json & i(int64_t v) { sep(); b += std::to_string(v); return *this; }
    Json & u(uint64_t v) { sep(); b += std::to_string(v); return *this; }
    Json & boolean(bool v) { sep(); b += v ? "true" : "false"; return *this; }
    Json & null() { sep(); b += "null"; return *this; }
    // %.9g round-trips a float exactly; non-finite values become null.
    Json & f(double v, const char * fmt = "%.9g") {
        sep();
        if (!std::isfinite(v)) { b += "null"; return *this; }
        char t[32]; snprintf(t, sizeof t, fmt, v); b += t; return *this;
    }
};

// One event per line on stdout. The base fields come first.
static Json begin_event(const char * type, int step, int64_t t_us = -1) {
    Json j;
    j.obj();
    j.k("type").s(type);
    j.k("step").i(step);
    j.k("t_us").i(t_us < 0 ? now_us() : t_us);
    return j;
}

static void emit(Json & j) {
    j.end();
    j.b += '\n';
    fwrite(j.b.data(), 1, j.b.size(), stdout);
    fflush(stdout);
}

// ---------------------------------------------------------------------------------------------
// Settings

struct Settings {
    std::string model;
    std::string prompt = "Once upon a time";
    int n_predict = 12;
    uint32_t seed = 1;
    bool greedy = false;
    int top_k = 40;
    float top_p = 0.95f;
    float temp = 0.8f;
    int ctx_size = 0;   // 0: n_prompt + n_predict
    bool verbose = false;
    std::vector<std::string> capture = {"kq_soft_max", "l_out", "result_output"};
};

static void usage(const char * argv0) {
    fprintf(stderr,
        "usage: %s --model FILE [--prompt TEXT] [--n-predict N] [--seed N]\n"
        "          [--greedy | --top-k N --top-p P --temp T] [--ctx-size N]\n"
        "          [--capture name,name,...] [--verbose]\n"
        "Writes newline-delimited JSON trace events to stdout.\n", argv0);
}

static bool parse_args(int argc, char ** argv, Settings & st) {
    for (int i = 1; i < argc; i++) {
        std::string a = argv[i];
        auto next = [&](const char * what) -> const char * {
            if (i + 1 >= argc) { fprintf(stderr, "missing value for %s\n", what); exit(2); }
            return argv[++i];
        };
        if      (a == "--model" || a == "-m")     st.model = next("--model");
        else if (a == "--prompt" || a == "-p")    st.prompt = next("--prompt");
        else if (a == "--n-predict" || a == "-n") st.n_predict = atoi(next("--n-predict"));
        else if (a == "--seed")                   st.seed = (uint32_t) strtoul(next("--seed"), nullptr, 10);
        else if (a == "--greedy")                 st.greedy = true;
        else if (a == "--top-k")                  st.top_k = atoi(next("--top-k"));
        else if (a == "--top-p")                  st.top_p = (float) atof(next("--top-p"));
        else if (a == "--temp")                   st.temp = (float) atof(next("--temp"));
        else if (a == "--ctx-size" || a == "-c")  st.ctx_size = atoi(next("--ctx-size"));
        else if (a == "--verbose" || a == "-v")   st.verbose = true;
        else if (a == "--capture") {
            st.capture.clear();
            std::string v = next("--capture");
            size_t p = 0;
            while (p <= v.size()) {
                size_t q = v.find(',', p);
                if (q == std::string::npos) q = v.size();
                if (q > p) st.capture.push_back(v.substr(p, q - p));
                p = q + 1;
            }
        }
        else if (a == "--help" || a == "-h") { usage(argv[0]); exit(0); }
        else { fprintf(stderr, "unknown argument: %s\n", a.c_str()); usage(argv[0]); return false; }
    }
    if (st.model.empty()) { usage(argv[0]); return false; }
    if (st.n_predict < 1) { fprintf(stderr, "--n-predict must be >= 1\n"); return false; }
    return true;
}

// ---------------------------------------------------------------------------------------------
// Tensor naming helpers (llama.cpp naming conventions, read from the pinned source)

// ggml appends " (view)", " (permuted)", " (reshaped)", " (copy of ...)" etc. to derived names.
static std::string strip_ggml_suffix(const std::string & name) {
    size_t p = name.find(" (");
    if (p == std::string::npos && !name.empty() && name[0] == '(') return "";
    return p == std::string::npos ? name : name.substr(0, p);
}

// "attn_out-3" -> ("attn_out", 3); "blk.2.attn_q.weight" -> layer 2; "cache_k_l4" -> layer 4.
static void split_layer(const std::string & stripped, std::string & base, int & layer) {
    base = stripped;
    layer = -1;
    size_t dash = stripped.rfind('-');
    if (dash != std::string::npos && dash + 1 < stripped.size() &&
        std::all_of(stripped.begin() + dash + 1, stripped.end(), ::isdigit)) {
        base = stripped.substr(0, dash);
        layer = atoi(stripped.c_str() + dash + 1);
        return;
    }
    if (stripped.rfind("blk.", 0) == 0) {
        layer = atoi(stripped.c_str() + 4);
        return;
    }
    if (stripped.rfind("cache_k_l", 0) == 0 || stripped.rfind("cache_v_l", 0) == 0) {
        layer = atoi(stripped.c_str() + 9);
    }
}

static bool is_generic_name(const std::string & stripped) {
    if (stripped.empty()) return true;
    if (stripped.rfind("node_", 0) == 0 &&
        std::all_of(stripped.begin() + 5, stripped.end(), ::isdigit)) return true;
    return false;
}

// ---------------------------------------------------------------------------------------------
// Graph capture through cb_eval

struct NodeRec {
    const ggml_tensor * t;
    std::string op, name, dtype;
    int64_t ne[4];
    int32_t flags;
    bool is_weight;
    bool is_host;
    std::vector<const ggml_tensor *> src;
};

struct ExecRec {
    int id;
    int64_t t_us;    // when the node was handed to the scheduler (ask == true returned)
    int64_t dur_us;
    bool computed;
    bool has_stats = false;
    double min = 0, max = 0, mean = 0;
    int64_t n_nan = 0, n_pinf = 0, n_ninf = 0;
    bool finite_any = false;
    std::vector<float> values;
    bool has_values = false;
};

struct Tracer {
    Settings st;
    std::set<std::string> capture;

    // the graph of the current decode, in callback visit order
    std::vector<NodeRec> nodes;
    std::unordered_map<const ggml_tensor *, int> node_index;
    std::vector<ExecRec> execs;
    int64_t t_ask_return = 0;
    int pending = -1;          // index of the node between ask==true and ask==false

    // the graph that llama.cpp keeps for reuse
    std::vector<const ggml_tensor *> prev_ptrs;
};

static Tracer * g_tr = nullptr;

static bool weight_tensor(const ggml_tensor * t) {
    return t->buffer && ggml_backend_buffer_get_usage(t->buffer) == GGML_BACKEND_BUFFER_USAGE_WEIGHTS;
}

static double read_elem(const ggml_tensor * t, const char * p) {
    switch (t->type) {
        case GGML_TYPE_F32: return *(const float *) p;
        case GGML_TYPE_F16: return ggml_fp16_to_fp32(*(const ggml_fp16_t *) p);
        case GGML_TYPE_BF16: return ggml_bf16_to_fp32(*(const ggml_bf16_t *) p);
        case GGML_TYPE_I32: return *(const int32_t *) p;
        case GGML_TYPE_I64: return (double) *(const int64_t *) p;
        case GGML_TYPE_I16: return *(const int16_t *) p;
        case GGML_TYPE_I8:  return *(const int8_t *) p;
        default: return NAN;
    }
}

static bool stats_type(ggml_type ty) {
    switch (ty) {
        case GGML_TYPE_F32: case GGML_TYPE_F16: case GGML_TYPE_BF16:
        case GGML_TYPE_I32: case GGML_TYPE_I64: case GGML_TYPE_I16: case GGML_TYPE_I8: return true;
        default: return false;
    }
}

// Walk the tensor through its strides (views and permutes are not contiguous).
static void summarize(const ggml_tensor * t, ExecRec & e, bool want_values) {
    if (!stats_type(t->type) || t->data == nullptr || !t->buffer || !ggml_backend_buffer_is_host(t->buffer)) return;
    e.has_stats = true;
    double sum = 0; int64_t nfin = 0;
    double mn = INFINITY, mx = -INFINITY;
    if (want_values) { e.values.reserve(ggml_nelements(t)); e.has_values = true; }
    const char * base = (const char *) t->data;
    for (int64_t i3 = 0; i3 < t->ne[3]; i3++)
    for (int64_t i2 = 0; i2 < t->ne[2]; i2++)
    for (int64_t i1 = 0; i1 < t->ne[1]; i1++)
    for (int64_t i0 = 0; i0 < t->ne[0]; i0++) {
        double v = read_elem(t, base + i0*t->nb[0] + i1*t->nb[1] + i2*t->nb[2] + i3*t->nb[3]);
        if (want_values) e.values.push_back((float) v);
        if (std::isnan(v)) { e.n_nan++; continue; }
        if (std::isinf(v)) { if (v > 0) e.n_pinf++; else e.n_ninf++; continue; }
        sum += v; nfin++;
        mn = std::min(mn, v); mx = std::max(mx, v);
    }
    e.finite_any = nfin > 0;
    if (nfin > 0) { e.min = mn; e.max = mx; e.mean = sum / nfin; }
}

static bool cb_eval(ggml_tensor * t, bool ask, void * ud) {
    auto * tr = (Tracer *) ud;
    if (ask) {
        NodeRec r;
        r.t = t;
        r.op = ggml_op_desc(t);
        r.name = ggml_get_name(t);
        r.dtype = ggml_type_name(t->type);
        for (int k = 0; k < 4; k++) r.ne[k] = t->ne[k];
        r.flags = t->flags;
        r.is_weight = weight_tensor(t);
        r.is_host = t->buffer && ggml_backend_buffer_is_host(t->buffer);
        for (int k = 0; k < GGML_MAX_SRC; k++) if (t->src[k]) r.src.push_back(t->src[k]);
        tr->pending = (int) tr->nodes.size();
        tr->node_index[t] = tr->pending;
        tr->nodes.push_back(std::move(r));
        tr->t_ask_return = now_us();
        return true;   // observe every node: the scheduler computes one node at a time
    }

    const int64_t t_done = now_us();
    ExecRec e;
    e.id = tr->pending;
    e.t_us = tr->t_ask_return;
    e.dur_us = t_done - tr->t_ask_return;
    e.computed = (t->flags & GGML_TENSOR_FLAG_COMPUTE) != 0;
    if (e.computed) {
        std::string base; int layer;
        split_layer(strip_ggml_suffix(ggml_get_name(t)), base, layer);
        const bool full = t->type == GGML_TYPE_F32 && tr->capture.count(base) &&
                          strip_ggml_suffix(ggml_get_name(t)) == ggml_get_name(t);
        summarize(t, e, full);
    }
    tr->execs.push_back(std::move(e));
    tr->pending = -1;
    return true;
}

// ---------------------------------------------------------------------------------------------
// Events

static std::string meta_str(const llama_model * m, const char * key) {
    std::vector<char> buf(256);
    int n = llama_model_meta_val_str(m, key, buf.data(), buf.size());
    if (n < 0) return std::string();
    if ((size_t) n >= buf.size()) { buf.resize(n + 1); llama_model_meta_val_str(m, key, buf.data(), buf.size()); }
    return std::string(buf.data(), n);
}

static std::string token_piece(const llama_vocab * vocab, llama_token id) {
    std::vector<char> buf(64);
    int n = llama_token_to_piece(vocab, id, buf.data(), buf.size(), 0, true);
    if (n < 0) { buf.resize(-n); n = llama_token_to_piece(vocab, id, buf.data(), buf.size(), 0, true); }
    return std::string(buf.data(), std::max(n, 0));
}

static std::string detokenize(const llama_vocab * vocab, const llama_token * toks, int n) {
    std::vector<char> buf(256);
    int r = llama_detokenize(vocab, toks, n, buf.data(), buf.size(), /*remove_special*/ false, /*unparse_special*/ false);
    if (r < 0) { buf.resize(-r); r = llama_detokenize(vocab, toks, n, buf.data(), buf.size(), false, false); }
    return std::string(buf.data(), std::max(r, 0));
}

static const char * vocab_type_name(enum llama_vocab_type t) {
    switch (t) {
        case LLAMA_VOCAB_TYPE_NONE:   return "NONE";
        case LLAMA_VOCAB_TYPE_SPM:    return "SPM";
        case LLAMA_VOCAB_TYPE_BPE:    return "BPE";
        case LLAMA_VOCAB_TYPE_WPM:    return "WPM";
        case LLAMA_VOCAB_TYPE_UGM:    return "UGM";
        case LLAMA_VOCAB_TYPE_RWKV:   return "RWKV";
        case LLAMA_VOCAB_TYPE_PLAMO2: return "PLAMO2";
        case LLAMA_VOCAB_TYPE_TEST:   return "TEST";
        case LLAMA_VOCAB_TYPE_PLAMO3: return "PLAMO3";
    }
    return "UNKNOWN";
}

static void emit_graph(const Tracer & tr, int step, bool reused, int graph_id, int64_t t_us) {
    const int n_nodes = (int) tr.nodes.size();

    // leaves: src tensors that are not graph nodes, numbered after the nodes in discovery order
    std::vector<const ggml_tensor *> leaves;
    std::unordered_map<const ggml_tensor *, int> leaf_index;
    for (const auto & r : tr.nodes) {
        for (const auto * s : r.src) {
            if (tr.node_index.count(s) || leaf_index.count(s)) continue;
            leaf_index[s] = n_nodes + (int) leaves.size();
            leaves.push_back(s);
        }
    }
    auto id_of = [&](const ggml_tensor * s) {
        auto it = tr.node_index.find(s);
        return it != tr.node_index.end() ? it->second : leaf_index.at(s);
    };

    Json j = begin_event("graph", step, t_us);
    j.k("reused").boolean(reused);
    j.k("graph_id").i(graph_id);
    j.k("n_nodes").i(n_nodes);
    j.k("n_leafs").i((int64_t) leaves.size());
    if (!reused) {
        // group: generic-named op nodes attach to the first named node downstream
        std::vector<std::vector<int>> consumers(n_nodes);
        for (int i = 0; i < n_nodes; i++)
            for (const auto * s : tr.nodes[i].src) {
                int sid = id_of(s);
                if (sid < n_nodes) consumers[sid].push_back(i);
            }
        std::vector<int> group(n_nodes), layer(n_nodes);
        std::vector<std::string> base(n_nodes);
        for (int i = n_nodes - 1; i >= 0; i--) {
            std::string stripped = strip_ggml_suffix(tr.nodes[i].name);
            split_layer(stripped, base[i], layer[i]);
            group[i] = i;
            if (is_generic_name(stripped) && !consumers[i].empty()) {
                int c = *std::min_element(consumers[i].begin(), consumers[i].end());
                group[i] = group[c];
                layer[i] = layer[group[i]];
            }
        }

        j.k("nodes").arr();
        for (int i = 0; i < n_nodes; i++) {
            const auto & r = tr.nodes[i];
            j.obj();
            j.k("id").i(i);
            j.k("kind").s("op");
            j.k("op").s(r.op);
            j.k("name").s(r.name);
            j.k("base").s(base[i]);
            j.k("layer"); if (layer[i] >= 0) j.i(layer[i]); else j.null();
            j.k("group").i(group[i]);
            j.k("shape").arr(); for (int k = 0; k < 4; k++) j.i(r.ne[k]); j.aend();
            j.k("dtype").s(r.dtype);
            j.k("is_weight").boolean(r.is_weight);
            j.k("computed").boolean((r.flags & GGML_TENSOR_FLAG_COMPUTE) != 0);
            j.k("is_input").boolean((r.flags & GGML_TENSOR_FLAG_INPUT) != 0);
            j.k("is_output").boolean((r.flags & GGML_TENSOR_FLAG_OUTPUT) != 0);
            j.end();
        }
        for (size_t li = 0; li < leaves.size(); li++) {
            const ggml_tensor * t = leaves[li];
            const std::string name = ggml_get_name(t);
            std::string b; int l;
            split_layer(strip_ggml_suffix(name), b, l);
            const bool w = weight_tensor(t);
            const char * kind = w ? "weight"
                : (name.rfind("cache_k_", 0) == 0 || name.rfind("cache_v_", 0) == 0) ? "kv_cache"
                : (t->flags & GGML_TENSOR_FLAG_INPUT) ? "input" : "leaf";
            j.obj();
            j.k("id").i(n_nodes + (int64_t) li);
            j.k("kind").s(kind);
            j.k("op").s(ggml_op_desc(t));
            j.k("name").s(name);
            j.k("base").s(b);
            j.k("layer"); if (l >= 0) j.i(l); else j.null();
            j.k("group").i(n_nodes + (int64_t) li);
            j.k("shape").arr(); for (int k = 0; k < 4; k++) j.i(t->ne[k]); j.aend();
            j.k("dtype").s(ggml_type_name(t->type));
            j.k("is_weight").boolean(w);
            j.k("computed").boolean((t->flags & GGML_TENSOR_FLAG_COMPUTE) != 0);
            j.k("is_input").boolean((t->flags & GGML_TENSOR_FLAG_INPUT) != 0);
            j.k("is_output").boolean((t->flags & GGML_TENSOR_FLAG_OUTPUT) != 0);
            j.end();
        }
        j.aend();

        j.k("edges").arr();
        for (int i = 0; i < n_nodes; i++)
            for (const auto * s : tr.nodes[i].src) { j.arr(); j.i(id_of(s)); j.i(i); j.aend(); }
        j.aend();
    }
    emit(j);
}

static void emit_node_execs(const Tracer & tr, int step) {
    for (size_t k = 0; k < tr.execs.size(); k++) {
        const auto & e = tr.execs[k];
        Json j = begin_event("node_exec", step, e.t_us);
        j.k("id").i(e.id);
        j.k("seq").i((int64_t) k);
        j.k("dur_us").i(e.dur_us);
        j.k("computed").boolean(e.computed);
        if (e.has_stats) {
            j.k("stats").obj();
            j.k("min");  if (e.finite_any) j.f(e.min);  else j.null();
            j.k("max");  if (e.finite_any) j.f(e.max);  else j.null();
            j.k("mean"); if (e.finite_any) j.f(e.mean); else j.null();
            j.k("n_nan").i(e.n_nan);
            j.k("n_pos_inf").i(e.n_pinf);
            j.k("n_neg_inf").i(e.n_ninf);
            j.end();
        }
        if (e.has_values) {
            j.k("values").arr();
            for (float v : e.values) j.f(v, "%.7g");
            j.aend();
        }
        emit(j);
    }
}

static void emit_candidates(Json & j, const llama_token_data_array & a) {
    j.k("candidates").arr();
    for (size_t i = 0; i < a.size; i++) {
        j.obj();
        j.k("id").i(a.data[i].id);
        j.k("logit").f(a.data[i].logit);
        j.k("p").f(a.data[i].p);
        j.end();
    }
    j.aend();
}

// ---------------------------------------------------------------------------------------------

static void log_cb(enum ggml_log_level level, const char * text, void * ud) {
    const bool verbose = *(bool *) ud;
    if (verbose || level == GGML_LOG_LEVEL_ERROR) fputs(text, stderr);
}

int main(int argc, char ** argv) {
    Tracer tr;
    g_tr = &tr;
    if (!parse_args(argc, argv, tr.st)) return 2;
    Settings & st = tr.st;
    tr.capture.insert(st.capture.begin(), st.capture.end());

    llama_log_set(log_cb, &st.verbose);
    llama_backend_init();
    g_t0 = ggml_time_us();

    // ---- load -----------------------------------------------------------------------------
    const int64_t t_load0 = now_us();
    llama_model_params mp = llama_model_default_params();
    mp.n_gpu_layers = 0;
    llama_model * model = llama_model_load_from_file(st.model.c_str(), mp);
    if (!model) { fprintf(stderr, "tracer: failed to load model %s\n", st.model.c_str()); return 1; }
    const llama_vocab * vocab = llama_model_get_vocab(model);

    // count prompt tokens to size the context (the traced tokenize call comes later)
    const int n_prompt = -llama_tokenize(vocab, st.prompt.c_str(), (int) st.prompt.size(), nullptr, 0, true, true);
    if (n_prompt <= 0) { fprintf(stderr, "tracer: prompt tokenizes to no tokens\n"); return 1; }

    const int n_ctx_train = llama_model_n_ctx_train(model);
    const int n_ctx_req = st.ctx_size > 0 ? st.ctx_size : n_prompt + st.n_predict;
    if (n_prompt + st.n_predict > n_ctx_req || n_ctx_req > n_ctx_train) {
        fprintf(stderr, "tracer: prompt (%d tokens) + n_predict (%d) does not fit context %d (n_ctx_train %d)\n",
                n_prompt, st.n_predict, n_ctx_req, n_ctx_train);
        return 1;
    }

    llama_context_params cp = llama_context_default_params();
    cp.n_ctx = n_ctx_req;
    cp.n_batch = n_ctx_req;           // the whole prompt is one batch ...
    cp.n_ubatch = n_ctx_req;          // ... and one ubatch, so prefill is one graph
    cp.n_seq_max = 1;
    cp.n_threads = 1;
    cp.n_threads_batch = 1;
    cp.flash_attn_type = LLAMA_FLASH_ATTN_TYPE_DISABLED;  // keep kq / kq_soft_max as separate nodes
    cp.cb_eval = cb_eval;
    cp.cb_eval_user_data = &tr;
    cp.no_perf = false;
    llama_context * ctx = llama_init_from_model(model, cp);
    if (!ctx) { fprintf(stderr, "tracer: failed to create context\n"); return 1; }
    const int64_t t_load = now_us() - t_load0;

    const char * reuse_env = getenv("LLAMA_GRAPH_REUSE_DISABLE");
    const bool reuse_disabled = reuse_env && atoi(reuse_env) != 0;

    // ---- model_info -------------------------------------------------------------------------
    {
        const std::string arch = meta_str(model, "general.architecture");
        const std::string name = meta_str(model, "general.name");
        const std::string key_len = meta_str(model, (arch + ".attention.key_length").c_str());
        const std::string n_ff = meta_str(model, (arch + ".feed_forward_length").c_str());
        char desc[256]; llama_model_desc(model, desc, sizeof desc);
        struct stat sb; const int64_t file_size = stat(st.model.c_str(), &sb) == 0 ? (int64_t) sb.st_size : 0;
        const std::string fname = st.model.substr(st.model.find_last_of('/') + 1);
        const int n_head = llama_model_n_head(model);

        Json j = begin_event("model_info", 0);
        j.k("arch").s(arch);
        j.k("name"); if (name.empty()) j.null(); else j.s(name);
        j.k("desc").s(desc);
        j.k("n_layer").i(llama_model_n_layer(model));
        j.k("n_embd").i(llama_model_n_embd(model));
        j.k("n_head").i(n_head);
        j.k("n_head_kv").i(llama_model_n_head_kv(model));
        j.k("n_embd_head").i(!key_len.empty() ? atoi(key_len.c_str()) : llama_model_n_embd(model) / std::max(n_head, 1));
        j.k("n_ff"); if (n_ff.empty()) j.null(); else j.i(atoi(n_ff.c_str()));
        j.k("n_vocab").i(llama_vocab_n_tokens(vocab));
        j.k("vocab_type").s(vocab_type_name(llama_vocab_type(vocab)));
        j.k("n_ctx_train").i(n_ctx_train);
        j.k("n_ctx").i(llama_n_ctx(ctx));
        j.k("n_batch").i(llama_n_batch(ctx));
        j.k("n_ubatch").i(llama_n_ubatch(ctx));
        j.k("n_params").u(llama_model_n_params(model));
        j.k("model_size").u(llama_model_size(model));
        j.k("file_size").i(file_size);
        j.k("file_name").s(fname);
        const llama_token bos = llama_vocab_bos(vocab), eos = llama_vocab_eos(vocab);
        j.k("bos_id"); if (bos == LLAMA_TOKEN_NULL) j.null(); else j.i(bos);
        j.k("eos_id"); if (eos == LLAMA_TOKEN_NULL) j.null(); else j.i(eos);
        j.k("meta").obj();
        for (int i = 0; i < llama_model_meta_count(model); i++) {
            char kbuf[256];
            if (llama_model_meta_key_by_index(model, i, kbuf, sizeof kbuf) < 0) continue;
            std::vector<char> vbuf(512);
            int n = llama_model_meta_val_str_by_index(model, i, vbuf.data(), vbuf.size());
            if (n < 0) continue;
            if ((size_t) n >= vbuf.size()) { vbuf.resize(n + 1); n = llama_model_meta_val_str_by_index(model, i, vbuf.data(), vbuf.size()); }
            j.k(kbuf).s(std::string(vbuf.data(), n));
        }
        j.end();
        j.k("llama_cpp").obj().k("commit").s(LLAMACPP_COMMIT);
        j.k("tag"); if (strlen(LLAMACPP_TAG) == 0) j.null(); else j.s(LLAMACPP_TAG);
        j.end();
        j.k("system_info").s(llama_print_system_info());
        j.k("settings").obj();
        j.k("prompt").s(st.prompt);
        j.k("n_predict").i(st.n_predict);
        j.k("seed").u(st.seed);
        j.k("sampling").s(st.greedy ? "greedy" : "dist");
        j.k("top_k").i(st.top_k);
        j.k("top_p").f(st.top_p);
        j.k("temp").f(st.temp);
        j.k("n_threads").i(llama_n_threads(ctx));
        j.k("flash_attn").boolean(false);
        j.k("capture").arr(); for (const auto & c : st.capture) j.s(c); j.aend();
        j.k("graph_reuse_disabled").boolean(reuse_disabled);
        j.end();
        emit(j);
    }

    // ---- tokenize ---------------------------------------------------------------------------
    std::vector<llama_token> prompt_tokens(n_prompt);
    int64_t t_tokenize = 0;
    {
        const int64_t t_tok0 = now_us();
        const int r = llama_tokenize(vocab, st.prompt.c_str(), (int) st.prompt.size(),
                                     prompt_tokens.data(), (int) prompt_tokens.size(), true, true);
        t_tokenize = now_us() - t_tok0;
        if (r != n_prompt) { fprintf(stderr, "tracer: tokenize returned %d, expected %d\n", r, n_prompt); return 1; }

        // Byte spans from cumulative llama_detokenize. SPM vocabularies add a space prefix during
        // tokenization that detokenize keeps, so the detokenized text may be the prompt with extra
        // leading bytes; spans are reported relative to the prompt. Null if it does not round-trip.
        const std::string detok = detokenize(vocab, prompt_tokens.data(), n_prompt);
        bool spans_ok = detok.size() >= st.prompt.size() &&
                        detok.compare(detok.size() - st.prompt.size(), st.prompt.size(), st.prompt) == 0;
        const size_t offset = spans_ok ? detok.size() - st.prompt.size() : 0;
        std::vector<size_t> ends(n_prompt);
        for (int i = 0; spans_ok && i < n_prompt; i++) {
            const size_t len = detokenize(vocab, prompt_tokens.data(), i + 1).size();
            ends[i] = len > offset ? len - offset : 0;
            if (ends[i] > st.prompt.size() || (i > 0 && ends[i] < ends[i - 1])) spans_ok = false;
        }

        Json j = begin_event("tokenize", 0, t_tok0);
        j.k("prompt").s(st.prompt);
        j.k("prompt_bytes").i((int64_t) st.prompt.size());
        j.k("detokenized").s(detok);
        j.k("add_special").boolean(true);
        j.k("parse_special").boolean(true);
        j.k("dur_us").i(t_tokenize);
        j.k("tokens").arr();
        for (int i = 0; i < n_prompt; i++) {
            const std::string piece = token_piece(vocab, prompt_tokens[i]);
            j.obj();
            j.k("id").i(prompt_tokens[i]);
            j.k("piece").s(piece);
            j.k("piece_hex").s(hex(piece));
            if (spans_ok) { j.k("start").i(i == 0 ? 0 : (int64_t) ends[i - 1]); j.k("end").i((int64_t) ends[i]); }
            else          { j.k("start").null(); j.k("end").null(); }
            j.k("special").boolean(llama_vocab_is_control(vocab, prompt_tokens[i]));
            j.k("attr").i((int64_t) llama_vocab_get_attr(vocab, prompt_tokens[i]));
            j.end();
        }
        j.aend();
        emit(j);
    }

    // ---- samplers ---------------------------------------------------------------------------
    struct Stage { llama_sampler * s; std::vector<std::pair<std::string, double>> params; };
    std::vector<Stage> stages;
    if (st.greedy) {
        stages.push_back({llama_sampler_init_greedy(), {}});
    } else {
        stages.push_back({llama_sampler_init_top_k(st.top_k), {{"k", st.top_k}}});
        stages.push_back({llama_sampler_init_top_p(st.top_p, 1), {{"p", st.top_p}, {"min_keep", 1}}});
        stages.push_back({llama_sampler_init_temp(st.temp), {{"t", st.temp}}});
        stages.push_back({llama_sampler_init_dist(st.seed), {{"seed", (double) st.seed}}});
    }

    // ---- decode loop ------------------------------------------------------------------------
    const int n_vocab = llama_vocab_n_tokens(vocab);
    llama_memory_t mem = llama_get_memory(ctx);
    llama_batch batch = llama_batch_init(n_prompt, 0, 1);
    std::vector<llama_token_data> cand(n_vocab);

    std::vector<llama_token> cur_tokens = prompt_tokens;
    llama_pos n_past = 0;
    int graph_id = -1, n_built = 0, n_reused_total = 0, n_generated = 0, n_decode = 0;
    int64_t t_prefill = 0, t_decode = 0, t_sample = 0;
    std::string text;
    const char * reason = "n_predict";
    std::string error;

    for (int step = 0; ; step++) {
        // batch
        batch.n_tokens = (int32_t) cur_tokens.size();
        for (int i = 0; i < batch.n_tokens; i++) {
            batch.token[i] = cur_tokens[i];
            batch.pos[i] = n_past + i;
            batch.n_seq_id[i] = 1;
            batch.seq_id[i][0] = 0;
            batch.logits[i] = i == batch.n_tokens - 1;
        }
        {
            Json j = begin_event("batch", step);
            j.k("n_tokens").i(batch.n_tokens);
            j.k("kv_pos_max_before").i(llama_memory_seq_pos_max(mem, 0));
            j.k("rows").arr();
            for (int i = 0; i < batch.n_tokens; i++) {
                j.obj();
                j.k("token").i(batch.token[i]);
                j.k("pos").i(batch.pos[i]);
                j.k("seq_id").arr().i(batch.seq_id[i][0]).aend();
                j.k("logits").boolean(batch.logits[i] != 0);
                j.end();
            }
            j.aend();
            emit(j);
        }

        // decode, observing every node through cb_eval
        tr.nodes.clear(); tr.node_index.clear(); tr.execs.clear();
        const int reused_before = llama_perf_context(ctx).n_reused;
        const int64_t t_dec0 = now_us();
        const int ret = llama_decode(ctx, batch);
        const int64_t dur = now_us() - t_dec0;
        const bool reused = llama_perf_context(ctx).n_reused > reused_before;
        n_decode++;
        if (step == 0) t_prefill += dur; else t_decode += dur;

        if (ret != 0) {
            reason = "error";
            error = "llama_decode returned " + std::to_string(ret);
            fprintf(stderr, "tracer: %s\n", error.c_str());
            break;
        }

        // cross-check the reuse flag against the tensors the scheduler visited
        std::vector<const ggml_tensor *> ptrs;
        for (const auto & r : tr.nodes) ptrs.push_back(r.t);
        if (reused && ptrs != tr.prev_ptrs) {
            fprintf(stderr, "tracer: llama.cpp reported graph reuse but visited different tensors\n");
            return 1;
        }
        tr.prev_ptrs = ptrs;
        if (reused) n_reused_total++; else { n_built++; graph_id++; }

        emit_graph(tr, step, reused, graph_id, t_dec0);
        emit_node_execs(tr, step);

        int64_t compute_us = 0; int n_computed = 0;
        for (const auto & e : tr.execs) { compute_us += e.dur_us; n_computed += e.computed; }
        n_past += batch.n_tokens;
        {
            Json j = begin_event("decode_end", step);
            j.k("ret").i(ret);
            j.k("dur_us").i(dur);
            j.k("compute_us").i(compute_us);
            j.k("kv_pos_max").i(llama_memory_seq_pos_max(mem, 0));
            j.k("kv_pos_min").i(llama_memory_seq_pos_min(mem, 0));
            j.k("n_nodes").i((int64_t) tr.nodes.size());
            j.k("n_computed").i(n_computed);
            j.k("reused").boolean(reused);
            j.k("graph_id").i(graph_id);
            emit(j);
        }

        // logits of the last output row
        const float * logits = llama_get_logits_ith(ctx, -1);
        {
            Json j = begin_event("logits", step);
            j.k("idx").i(-1);
            j.k("values").arr();
            for (int v = 0; v < n_vocab; v++) j.f(logits[v]);
            j.aend();
            emit(j);
        }

        // sampling: apply each sampler by hand and record the candidate array after each
        for (int v = 0; v < n_vocab; v++) cand[v] = llama_token_data{v, logits[v], 0.0f};
        llama_token_data_array cur_p = {cand.data(), cand.size(), -1, false};
        for (size_t si = 0; si < stages.size(); si++) {
            const int64_t ts0 = now_us();
            llama_sampler_apply(stages[si].s, &cur_p);
            const int64_t sdur = now_us() - ts0;
            t_sample += sdur;
            Json j = begin_event("sampler_stage", step, ts0);
            j.k("index").i((int64_t) si);
            j.k("name").s(llama_sampler_name(stages[si].s));
            j.k("params").obj();
            for (const auto & kv : stages[si].params) j.k(kv.first.c_str()).f(kv.second);
            j.end();
            j.k("dur_us").i(sdur);
            j.k("sorted").boolean(cur_p.sorted);
            j.k("selected").i(cur_p.selected);
            emit_candidates(j, cur_p);
            emit(j);
        }
        if (cur_p.selected < 0 || (size_t) cur_p.selected >= cur_p.size) {
            reason = "error"; error = "no token selected";
            fprintf(stderr, "tracer: %s\n", error.c_str());
            break;
        }
        const llama_token_data chosen = cur_p.data[cur_p.selected];
        for (auto & sg : stages) llama_sampler_accept(sg.s, chosen.id);

        const bool eog = llama_vocab_is_eog(vocab, chosen.id);
        const std::string piece = token_piece(vocab, chosen.id);
        n_generated++;
        if (!eog) text += piece;
        {
            Json j = begin_event("token_selected", step);
            j.k("id").i(chosen.id);
            j.k("piece").s(piece);
            j.k("piece_hex").s(hex(piece));
            j.k("p").f(chosen.p);
            j.k("logit").f(chosen.logit);
            j.k("selected").i(cur_p.selected);
            j.k("is_eog").boolean(eog);
            j.k("n_generated").i(n_generated);
            emit(j);
        }

        if (eog) { reason = "eog"; break; }
        if (n_generated >= st.n_predict) { reason = "n_predict"; break; }
        cur_tokens.assign(1, chosen.id);
    }

    // ---- done -------------------------------------------------------------------------------
    {
        const llama_perf_context_data pd = llama_perf_context(ctx);
        Json j = begin_event("done", n_decode > 0 ? n_decode - 1 : 0);
        j.k("reason").s(reason);
        if (!error.empty()) j.k("error").s(error);
        j.k("n_prompt").i(n_prompt);
        j.k("n_generated").i(n_generated);
        j.k("n_decode").i(n_decode);
        j.k("n_graphs_built").i(n_built);
        j.k("n_graphs_reused").i(n_reused_total);
        j.k("text").s(text);
        j.k("totals_us").obj();
        j.k("load").i(t_load);
        j.k("tokenize").i(t_tokenize);
        j.k("prefill").i(t_prefill);
        j.k("decode").i(t_decode);
        j.k("sample").i(t_sample);
        j.k("total").i(now_us());
        j.end();
        j.k("perf").obj();
        j.k("t_load_ms").f(pd.t_load_ms);
        j.k("t_p_eval_ms").f(pd.t_p_eval_ms);
        j.k("t_eval_ms").f(pd.t_eval_ms);
        j.k("n_p_eval").i(pd.n_p_eval);
        j.k("n_eval").i(pd.n_eval);
        j.k("n_reused").i(pd.n_reused);
        j.end();
        emit(j);
    }

    llama_batch_free(batch);
    for (auto & sg : stages) llama_sampler_free(sg.s);
    llama_free(ctx);
    llama_model_free(model);
    llama_backend_free();
    return std::string(reason) == "error" ? 1 : 0;
}
