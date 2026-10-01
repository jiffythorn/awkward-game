<?php
/**
 * The Awkward Game — AI provider catalog (THE list)
 * =================================================
 * The single source of truth for every known "bot brain" provider.
 * rooms/botlib.php builds the failover chain from this file + rooms/config.php;
 * rooms/ai.php exposes the list; README.md mirrors it as a human table.
 *
 * Chain order = catalog order (keyed clouds first), then custom providers,
 * then keyless local servers. If every member fails, bots fall back to the
 * built-in free template tier (no network, always works).
 *
 * Each entry:
 *   id       – stable identifier (used in config 'order'/'disabled'/'modelOverrides')
 *   label    – display name
 *   kind     – 'cloud' | 'local' | 'custom'
 *   url      – OpenAI-compatible POST endpoint for chat completions
 *   model    – default model id (override via config 'modelOverrides')
 *   keyEnv   – environment variable that holds the API key (null = keyless/local)
 *   freeTier – human note about cost
 *   docs     – where to get a key / install
 *
 * Add your own entries here, or better: rooms/config.php 'customProviders'
 * (survives updates, never edit vendor-ish files by accident).
 */
return [
  /* ---- keyed clouds (failover order below) -------------------------------- */
  [
    'id' => 'groq', 'label' => 'Groq', 'kind' => 'cloud',
    'url' => 'https://api.groq.com/openai/v1/chat/completions',
    'model' => 'llama-3.1-8b-instant', 'keyEnv' => 'GROQ_API_KEY',
    'freeTier' => 'free tier, rate-limited', 'docs' => 'https://console.groq.com/keys',
  ],
  [
    'id' => 'gemini', 'label' => 'Google Gemini', 'kind' => 'cloud',
    'url' => 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    'model' => 'gemini-2.0-flash', 'keyEnv' => 'GEMINI_API_KEY',
    'freeTier' => 'free tier, rate-limited', 'docs' => 'https://aistudio.google.com/apikey',
  ],
  [
    'id' => 'mistral', 'label' => 'Mistral', 'kind' => 'cloud',
    'url' => 'https://api.mistral.ai/v1/chat/completions',
    'model' => 'mistral-small-latest', 'keyEnv' => 'MISTRAL_API_KEY',
    'freeTier' => 'free tier, rate-limited', 'docs' => 'https://console.mistral.ai',
  ],
  [
    'id' => 'cerebras', 'label' => 'Cerebras', 'kind' => 'cloud',
    'url' => 'https://api.cerebras.ai/v1/chat/completions',
    'model' => 'llama-3.3-70b', 'keyEnv' => 'CEREBRAS_API_KEY',
    'freeTier' => 'free tier, generous limits', 'docs' => 'https://cloud.cerebras.ai',
  ],
  [
    'id' => 'openrouter', 'label' => 'OpenRouter', 'kind' => 'cloud',
    'url' => 'https://openrouter.ai/api/v1/chat/completions',
    'model' => 'meta-llama/llama-3.1-8b-instruct', 'keyEnv' => 'OPENROUTER_API_KEY',
    'freeTier' => 'several :free models', 'docs' => 'https://openrouter.ai/keys',
  ],
  [
    'id' => 'openai', 'label' => 'OpenAI', 'kind' => 'cloud',
    'url' => 'https://api.openai.com/v1/chat/completions',
    'model' => 'gpt-4o-mini', 'keyEnv' => 'OPENAI_API_KEY',
    'freeTier' => 'no (prepaid)', 'docs' => 'https://platform.openai.com/api-keys',
  ],
  [
    'id' => 'together', 'label' => 'Together AI', 'kind' => 'cloud',
    'url' => 'https://api.together.xyz/v1/chat/completions',
    'model' => 'Qwen/Qwen2.5-7B-Instruct', 'keyEnv' => 'TOGETHER_API_KEY',
    'freeTier' => 'trial credit', 'docs' => 'https://api.together.xyz',
  ],

  /* ---- keyless local servers (skipped instantly if not running) ------------ */
  [
    'id' => 'ollama', 'label' => 'Ollama (local)', 'kind' => 'local',
    'url' => 'http://127.0.0.1:11434/v1/chat/completions',
    'model' => 'qwen2.5:0.5b', 'keyEnv' => null,
    'freeTier' => 'your machine (0.5B–3B models run on weak PCs)',
    'docs' => 'https://ollama.com  →  ollama pull qwen2.5:0.5b',
  ],
  [
    'id' => 'llamacpp', 'label' => 'llama.cpp server (local)', 'kind' => 'local',
    'url' => 'http://127.0.0.1:8081/v1/chat/completions',
    'model' => 'local', 'keyEnv' => null,
    'freeTier' => 'your machine', 'docs' => 'https://github.com/ggml-org/llama.cpp',
  ],
  [
    'id' => 'lmstudio', 'label' => 'LM Studio (local)', 'kind' => 'local',
    'url' => 'http://127.0.0.1:1234/v1/chat/completions',
    'model' => 'local', 'keyEnv' => null,
    'freeTier' => 'your machine (GUI app)', 'docs' => 'https://lmstudio.ai',
  ],
];
