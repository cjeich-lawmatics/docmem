// Tame ONNX Runtime's intra-op threads. Without this, the threads spawned
// by @huggingface/transformers spin-wait when idle, which keeps the long-
// lived MCP server process pegged at ~100% CPU between requests. Setting
// these before the first model load makes idle threads block on a futex
// instead. Use `??=` so users can override if they need.
process.env.OMP_WAIT_POLICY ??= 'PASSIVE';
process.env.OMP_NUM_THREADS ??= '2';
