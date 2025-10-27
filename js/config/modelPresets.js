// js/config/modelPresets.js
//
// 仅保留：1) 本机 FastAPI 桥接配置；2) DeepSeek 直连(只用于中->英翻译)。
// 为防其他模块仍 import ORCHESTRATOR_API，这里导出一个空占位，避免运行时报错。
export const ORCHESTRATOR_API = null;

/** FastAPI 桥接 (宿主机，经 NAT 转到虚机 8080) */
export const BRIDGE_API = {
  /** 你已在宿主启动了端口映射到虚机: http://localhost:18080 -> 192.168.157.129:8080 */
  baseUrl: "http://localhost:18080",
  paths: {
    health: "/health",            // GET
    run: "/run",                  // POST
    status: "/status",            // GET /status/:job_id
    download: "/download"         // GET /download/:job_id
  },
  /** 结合你提供的真实路径，作为前端传给桥接的默认参数 */
  defaults: {
    openfoam_path: "/home/dyfluid/OpenFOAM/OpenFOAM-10",   // $WM_PROJECT_DIR
    prompt_path: "/home/dyfluid/work/Foam-Agent/user_requirement.txt",
    output_dir: "/home/dyfluid/work/Foam-Agent/output"
  }
};

/** 直连 DeepSeek 仅做“中文→英文”翻译。不要在前端提交真实密钥到公共环境。 */
export const MODEL_PRESETS = [
  {
    id: "deepseek-v1",
    label: "DeepSeek V1 (Translate)",
    request: {
      baseUrl: "https://api.deepseek.com",
      path: "/v1/chat/completions",
      model: "deepseek-chat",
      apiKey: "", // 建议运行时从 window.DEEPSEEK_API_KEY 或 localStorage 读取
      params: { temperature: 0.2 }
    }
  },
  {
    id: "deepseek-r1",
    label: "DeepSeek R1 (Translate+Reasoning)",
    request: {
      baseUrl: "https://api.deepseek.com",
      path: "/v1/chat/completions",
      model: "deepseek-reasoner",
      apiKey: "",
      params: { temperature: 0.1, reasoning: { effort: "medium" } }
    }
  }
];

export function getModelConfig(modelId) {
  return MODEL_PRESETS.find((p) => p.id === modelId) ?? MODEL_PRESETS[0] ?? null;
}
