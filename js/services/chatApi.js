// js/services/chatApi.js
//
// 说明：前端与 FastAPI 对齐 —— /run 用 requirement 字段；/status 统一出 status；
// 同时把 422 的 detail 数组转成可读错误文本，避免 [object Object]。

import { BRIDGE_API, getModelConfig } from "../config/modelPresets.js";

/* -------------------- 基础 HTTP -------------------- */
function stringifyFastApiError(data, res) {
  // 把 FastAPI 的 detail => "body.requirement: field required" 这样的字符串
  if (Array.isArray(data?.detail)) {
    return data.detail
      .map((e) => {
        const loc = Array.isArray(e?.loc) ? e.loc.join(".") : "";
        const msg = e?.msg || e?.type || "validation error";
        return loc ? `${loc}: ${msg}` : msg;
      })
      .join("; ");
  }
  if (typeof data?.detail === "string") return data.detail;
  if (typeof data?.message === "string") return data.message;
  return `${res?.status || ""} ${res?.statusText || "Request failed"}`.trim();
}

async function fetchJSON(url, init) {
  const res = await fetch(url, init);
  let raw = null;
  try { raw = await res.text(); } catch (_) { /* ignore */ }

  let data = null;
  if (raw && raw.length) {
    try { data = JSON.parse(raw); } catch (_) { /* ignore */ }
  }

  if (!res.ok) {
    const detail = stringifyFastApiError(data, res);
    throw new Error(detail);
  }
  return data;
}

/* -------------------- FastAPI 桥接：健康检查/提交/状态/下载 -------------------- */

/** GET /health */
export async function bridgeHealth() {
  const url = `${BRIDGE_API.baseUrl}${BRIDGE_API.paths.health}`;
  return fetchJSON(url);
}

/**
 * POST /run
 * 把英文需求写到 user_requirement.txt 并执行 foambench_main.py
 * @param {object} opts
 *  - prompt {string} 英文需求（必填）
 *  - case_name {string} 可选
 */
export async function runFoamAgent(opts) {
  const { prompt, case_name } = opts || {};
  if (!prompt || !prompt.trim()) {
    throw new Error("runFoamAgent: 缺少英文需求 prompt。");
  }

  const url = `${BRIDGE_API.baseUrl}${BRIDGE_API.paths.run}`;
  // 后端要求 requirement 字段；其它多余字段不传
  const body = { requirement: prompt, ...(case_name ? { case_name } : {}) };

  return fetchJSON(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

/**
 * GET /status/{job_id}
 * 统一把后端 state => 前端使用的 status
 */
export async function getJobStatus(jobId, options = {}) {
  if (!jobId) throw new Error("getJobStatus: 缺少 jobId。");
  const url = `${BRIDGE_API.baseUrl}${BRIDGE_API.paths.status}/${encodeURIComponent(jobId)}`;
  const data = await fetchJSON(url, { signal: options.signal });

  const map = { running: "running", finished: "succeeded", failed: "failed", queued: "queued" };
  const status = data?.status || map[data?.state] || "running";

  return { ...data, status };
}

/**
 * GET /download/{job_id} -> Blob
 */
export async function downloadResultZip(jobId) {
  if (!jobId) throw new Error("downloadResultZip: 缺少 jobId。");
  const url = `${BRIDGE_API.baseUrl}${BRIDGE_API.paths.download}/${encodeURIComponent(jobId)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

  const blob = await res.blob();
  const cd = res.headers.get("Content-Disposition") || "";
  const m = cd.match(/filename="?([^"]+)"?/i);
  const filename = m?.[1] || `foam-agent-${jobId}.zip`;
  return { blob, filename };
}

/** 仅拼出下载链接（供前端展示为 <a href>） */
export function downloadZipUrl(jobId) {
  if (!jobId) throw new Error("downloadZipUrl: 缺少 jobId。");
  return `${BRIDGE_API.baseUrl}${BRIDGE_API.paths.download}/${encodeURIComponent(jobId)}`;
}

/* -------------------- DeepSeek 翻译（中文 -> 英文） -------------------- */

export async function translateToEnglish(zhText, modelId = "deepseek-v1", options = {}) {
  if (!zhText || !zhText.trim()) return "";
  const messages = [
    {
      role: "system",
      content:
        "You are a professional technical translator. Translate the user input into concise, clear English for CFD simulation requirements. Preserve numbers, units, symbols, file or solver names. Output English only."
    },
    { role: "user", content: zhText }
  ];
  const { content } = await createChatCompletion(modelId, messages, options);
  return content || "";
}

/* -------------------- “中文直提交”封装 -------------------- */

export async function runJobChinese(zhText, options = {}) {
  const { modelId = "deepseek-v1", signal } = options;
  const english = await translateToEnglish(zhText, modelId, { signal });
  const res = await runFoamAgent({ prompt: english });
  const jobId = res?.job_id || res?.jobId || res?.id || null;
  return {
    ok: !!jobId,                // 以是否拿到 job_id 判定成功
    job_id: jobId,
    english,
    message: res?.message || null,
    zip_url: res?.zip_url || (jobId ? downloadZipUrl(jobId) : null)
  };
}

/** pollJob：薄封装 */
export async function pollJob(jobId, options = {}) {
  return getJobStatus(jobId, options);
}

/* -------------------- 直连 DeepSeek（仅用于翻译） -------------------- */

function normalizeUrl(baseUrl, path) {
  const trimmedBase = baseUrl.replace(/\/+$/, "");
  const trimmedPath = path.startsWith("/") ? path : `/${path}`;
  return `${trimmedBase}${trimmedPath}`;
}

function buildHeaders(requestConfig) {
  const runtimeKey =
    (typeof window !== "undefined" && (window.DEEPSEEK_API_KEY || localStorage.getItem("deepseek_api_key"))) || "";
  const apiKey = requestConfig.apiKey || runtimeKey;
  if (!apiKey) {
    throw new Error(
      "缺少 DeepSeek API Key。请在浏览器控制台设置 window.DEEPSEEK_API_KEY='sk-***' 或 localStorage.setItem('deepseek_api_key','sk-***')"
    );
  }
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    ...(requestConfig.headers ?? {})
  };
}

function sanitizeParams(params = {}) {
  const result = {};
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) result[k] = v;
  });
  return result;
}

export async function createChatCompletion(modelId, messages, options = {}) {
  const preset = getModelConfig(modelId);
  if (!preset) {
    throw new Error(`未找到模型 ${modelId} 的配置，请检查 js/config/modelPresets.js。`);
  }
  const cfg = preset.request;
  if (!cfg?.baseUrl || !cfg?.path || !cfg?.model) {
    throw new Error(`${preset.label} 缺少 baseUrl/path/model 配置。`);
  }

  const url = normalizeUrl(cfg.baseUrl, cfg.path);
  const payload = {
    model: cfg.model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    stream: false,
    ...sanitizeParams(cfg.params)
  };
  const headers = buildHeaders(cfg);

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: options.signal
  });

  const raw = await resp.text();
  let data = null;
  try { data = JSON.parse(raw); } catch (_) { /* ignore */ }

  if (!resp.ok) {
    const msg = data?.error?.message || `${resp.status} ${resp.statusText}`;
    throw new Error(msg);
  }

  const choice = Array.isArray(data?.choices) ? data.choices[0] : null;
  const message = choice?.message ?? {};
  const content = typeof message?.content === "string" ? message.content.trim() : (data?.output ?? "");
  const reasoning = typeof message?.reasoning_content === "string" ? message.reasoning_content.trim() : (data?.reasoning ?? "");

  return { content, reasoning };
}
