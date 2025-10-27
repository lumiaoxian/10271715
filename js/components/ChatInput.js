// js/components/ChatInput.js
// 功能：提交中文描述 → (chatApi 内部) 翻译成英文 → /run 启动任务 → 轮询 /status → 推送 /download 链接
// 彻底删除“fillIntent/意图面板/编排后端”相关逻辑

import {
  chatState,
  pushAssistantSummary,
  pushUserMessage,
  setStreaming
} from "../state/chatState.js";

import { icons } from "../utils/icons.js";
import { formatFileSize } from "../utils/files.js";

// 注意：这些函数需已在 js/services/chatApi.js 中实现
import {
  bridgeHealth,
  runJobChinese,
  pollJob,
  downloadZipUrl
} from "../services/chatApi.js";

export class ChatInput {
  constructor(root) {
    this.root = root;
    this.renderBase();

    this.form = this.root.querySelector("[data-role=input-form]");
    this.textarea = this.root.querySelector(".chat-input__textarea");
    this.submitButton = this.root.querySelector(".chat-input__submit");
    this.submitLabel = this.root.querySelector("[data-role=submit-label]");
    this.submitSpinner = this.root.querySelector("[data-role=submit-spinner]");
    this.statusEl = this.root.querySelector("[data-role=input-status]");
    this.attachButton = this.root.querySelector("[data-action=attach-file]");
    this.fileInput = this.root.querySelector("[data-role=file-input]");
    this.attachmentList = this.root.querySelector("[data-role=attachment-list]");
    this.toolbarButton = document.querySelector("[data-action=generate-settings]");
    this.toolbarLabel = this.toolbarButton?.querySelector("[data-role=toolbar-label]") ?? null;
    this.toolbarSpinner = this.toolbarButton?.querySelector("[data-role=toolbar-spinner]") ?? null;

    // 停止按钮 & 控制器/轮询器
    this.cancelButton = this.root.querySelector("[data-role=cancel-button]");
    this.activeController = null;
    this.pollTimer = null;
    this.activeJobId = null;

    this.attachments = [];
    this.lastConversationId = null;

    this.handleSubmit = this.handleSubmit.bind(this);
    this.handleInput = this.handleInput.bind(this);
    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleAttachClick = this.handleAttachClick.bind(this);
    this.handleFileChange = this.handleFileChange.bind(this);
    this.handleAttachmentRemove = this.handleAttachmentRemove.bind(this);
    this.handleGenerateClick = this.handleGenerateClick.bind(this);
    this.handleCancel = this.handleCancel.bind(this);

    this.form.addEventListener("submit", this.handleSubmit);
    this.textarea.addEventListener("input", this.handleInput);
    this.textarea.addEventListener("keydown", this.handleKeyDown);
    this.attachButton.addEventListener("click", this.handleAttachClick);
    this.fileInput.addEventListener("change", this.handleFileChange);
    this.attachmentList.addEventListener("click", this.handleAttachmentRemove);
    if (this.toolbarButton) this.toolbarButton.addEventListener("click", this.handleGenerateClick);
    if (this.cancelButton) this.cancelButton.addEventListener("click", this.handleCancel);

    this.autoResize();
    this.unsubscribe = chatState.subscribe((state) => this.render(state));

    // 可选：启动时探测桥健康状况
    bridgeHealth().catch(() => {});
  }

  renderBase() {
    this.root.innerHTML = `
      <form class="chat-input" data-role="input-form">
        <div class="chat-input__editor">
          <button
            type="button"
            class="chat-input__attach"
            data-action="attach-file"
            aria-label="上传 .stp 或 .msh 文件"
            title="上传 .stp 或 .msh 文件"
          >
            ${icons.paperclip}
          </button>
          <textarea
            class="chat-input__textarea"
            rows="1"
            placeholder="用中文描述你的CFD需求（例如：‘计算Re=1e5绕翼型稳态外流，输出阻力系数与压降’）"
            aria-label="输入消息"
          ></textarea>
          <input type="file" data-role="file-input" accept=".stp,.msh" hidden multiple />
          <div class="chat-input__buttons">
            <button type="submit" class="chat-input__submit" data-role="submit-button">
              <span class="chat-input__submit-icon" aria-hidden="true">${icons.send}</span>
              <span class="chat-input__submit-label" data-role="submit-label">提交任务</span>
              <span class="chat-input__spinner" data-role="submit-spinner" aria-hidden="true"></span>
            </button>
            <button type="button" class="chat-input__cancel" data-role="cancel-button" hidden>停止</button>
          </div>
        </div>
        <div class="chat-input__attachments" data-role="attachment-list"></div>
        <div class="chat-input__actions">
          <span>Enter 提交 · Shift+Enter 换行</span>
          <span data-role="input-status"></span>
        </div>
      </form>
    `;
  }

  render(state) {
    const { isStreaming, conversations, activeConversationId } = state;
    const conversation = conversations.find((x) => x.id === activeConversationId) ?? null;
    const conversationEnded = conversation?.ended === true;

    const baseCanSubmit = this.canSubmit();
    const canSubmit = !conversationEnded && baseCanSubmit;

    if (conversation?.id !== this.lastConversationId) {
      this.clearLocalAttachments();
      this.lastConversationId = conversation?.id ?? null;
    }

    this.textarea.disabled = isStreaming || conversationEnded;
    this.submitButton.disabled = isStreaming || !canSubmit;
    this.submitButton.title = conversationEnded
      ? "当前会话已结束"
      : isStreaming
        ? "任务执行中"
        : "提交任务到 Foam-Agent";
    this.submitButton.dataset.loading = isStreaming ? "true" : "false";
    this.submitButton.classList.toggle("is-loading", isStreaming);
    if (this.submitLabel) this.submitLabel.textContent = isStreaming ? "执行中…" : "提交任务";
    if (this.submitSpinner) this.submitSpinner.hidden = !isStreaming;

    this.attachButton.disabled = isStreaming || conversationEnded;

    if (this.toolbarButton) {
      this.toolbarButton.disabled = isStreaming || !canSubmit;
      this.toolbarButton.dataset.loading = isStreaming ? "true" : "false";
      this.toolbarButton.classList.toggle("is-loading", isStreaming);
      this.toolbarButton.setAttribute("aria-busy", isStreaming ? "true" : "false");
      if (this.toolbarLabel) this.toolbarLabel.textContent = isStreaming ? "执行中…" : "提交任务";
      if (this.toolbarSpinner) this.toolbarSpinner.hidden = !isStreaming;
    }

    if (this.cancelButton) {
      this.cancelButton.hidden = !isStreaming;
      this.cancelButton.disabled = !isStreaming;
    }

    if (conversationEnded) {
      this.statusEl.textContent = "当前会话已结束，请新建对话以继续。";
    } else if (isStreaming) {
      this.statusEl.textContent = "任务执行中…";
    } else if (!canSubmit) {
      this.statusEl.textContent = "请输入任务描述后提交";
    } else {
      this.statusEl.textContent = "";
    }
  }

  async handleSubmit(e) {
    e.preventDefault();
    await this.processInput();
  }

  handleInput() {
    this.autoResize();
    const state = chatState.getState();
    const conversation = state.conversations.find((x) => x.id === state.activeConversationId) ?? null;
    if (conversation?.ended) {
      this.submitButton.disabled = true;
      if (this.toolbarButton) this.toolbarButton.disabled = true;
      this.statusEl.textContent = "当前会话已结束，请新建对话以继续。";
      return;
    }
    const canSubmit = this.canSubmit();
    this.submitButton.disabled = !canSubmit;
    if (this.toolbarButton) this.toolbarButton.disabled = !canSubmit;
  }

  handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      this.form.requestSubmit();
    }
  }

  handleGenerateClick() {
    if (this.toolbarButton?.disabled) return;
    this.form.requestSubmit();
  }

  handleCancel() {
    // 停止前端请求与轮询（不会强制终止后端计算）
    try { this.activeController?.abort(); } catch {}
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.activeJobId = null;
    setStreaming(false);
    pushAssistantSummary("⏹️ 已停止本地轮询。若后端仍在计算，可稍后使用下载链接获取结果。");
    this.statusEl.textContent = "已停止轮询。";
  }

  async processInput() {
    const appState = chatState.getState();
    if (appState.isStreaming) return;

    const conversation = appState.conversations.find((x) => x.id === appState.activeConversationId) ?? null;
    if (conversation?.ended) {
      this.statusEl.textContent = "当前会话已结束，请新建对话以继续。";
      return;
    }

    const rawText = this.textarea.value;
    const content = rawText.trim();
    if (!content) {
      this.statusEl.textContent = "请先输入任务描述";
      return;
    }

    // 推送用户消息
    const payload = {
      text: rawText,
      attachments: this.attachments.map((it) => ({
        id: it.id, name: it.file.name, size: it.file.size, type: it.file.type, url: it.url
      }))
    };
    const userMsg = pushUserMessage(payload);
    if (!userMsg) return;

    // 清空输入框与附件区域
    this.textarea.value = "";
    this.autoResize();
    this.clearLocalAttachments({ release: false });
    this.fileInput.value = "";

    setStreaming(true);
    this.cancelButton.hidden = false;
    this.cancelButton.disabled = false;

    // 取消上一控制器
    if (this.activeController) {
      try { this.activeController.abort(); } catch {}
    }
    this.activeController = new AbortController();

    try {
      this.statusEl.textContent = "正在翻译为英文并提交到 Foam-Agent…";

      // 由 chatApi 封装：中文→英文 + POST /run
      const runResp = await runJobChinese(content, { signal: this.activeController.signal });
      // runResp: { ok: true, job_id, english, note? }

      if (!runResp?.ok || !runResp?.job_id) {
        throw new Error(runResp?.message || "后端未返回有效的 job_id");
      }

      // 展示英文文本与 job_id
      const jobId = runResp.job_id;
      this.activeJobId = jobId;

      const englishBlock = (runResp.english || "").trim();
      const head = `✅ 任务已提交到 Foam-Agent（Job: ${jobId}）`;
      const body = englishBlock
        ? `**英译文本**（会写入 \`user_requirement.txt\`）：\n\n${englishBlock}`
        : "*（未返回英译文本）*";
      pushAssistantSummary(`${head}\n\n${body}`);

      // 轮询状态
      this.statusEl.textContent = "任务已提交，正在轮询状态…";
      // 这里不保存返回值，避免未使用变量

      this.pollTimer = setInterval(async () => {
        try {
          const s = await pollJob(jobId, { signal: this.activeController.signal });
          // s: { status: "queued|running|succeeded|failed", message?, progress? }
          if (!s || !s.status) return;

          if (s.status === "queued" || s.status === "running") {
            this.statusEl.textContent = s.message ? `执行中：${s.message}` : "执行中…";
          } else if (s.status === "succeeded") {
            clearInterval(this.pollTimer);
            this.pollTimer = null;

            const url = downloadZipUrl(jobId);
            pushAssistantSummary(
              `✅ 仿真完成（Job: ${jobId}）。\n\n` +
              `📦 [下载结果 ZIP](${url})\n\n` +
              `> 结果包含 \`output/\` 下的关键文件；如需可视化，请在本地解压后用 ParaView 等工具查看。`
            );
            this.statusEl.textContent = "任务完成。";
            setStreaming(false);
            this.activeJobId = null;
          } else if (s.status === "failed") {
            clearInterval(this.pollTimer);
            this.pollTimer = null;

            pushAssistantSummary(`❌ 仿真失败（Job: ${jobId}）。${s.message ? `\n\n原因：${s.message}` : ""}`, null, { meta: { isError: true } });
            this.statusEl.textContent = "任务失败。";
            setStreaming(false);
            this.activeJobId = null;
          }
        } catch (err) {
          // 轮询抛错通常是网络/中断，不立刻终止，可在下次 tick 重试；若是 abort 则静默
          if (String(err?.name).includes("Abort")) return;
        }
      }, 1500);
    } catch (error) {
      const msg = error?.message ?? String(error ?? "未知错误");
      if (String(msg).toLowerCase().includes("abort")) {
        pushAssistantSummary("⏸️ 已取消本次提交/轮询。");
        this.statusEl.textContent = "已取消本次请求。";
      } else {
        pushAssistantSummary(`❌ 提交或翻译失败：${msg}`, null, { meta: { isError: true } });
        this.statusEl.textContent = `失败：${msg}`;
      }
      setStreaming(false);
      this.activeJobId = null;
    } finally {
      // 这里不隐藏“停止”按钮，让其在 isStreaming=false 时自动隐藏
      this.textarea.focus();
    }
  }

  handleAttachClick() {
    if (!this.attachButton.disabled) this.fileInput.click();
  }

  handleFileChange(e) {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;

    const accepted = ["stp", "msh"];
    const added = [];
    let hasInvalid = false;

    files.forEach((file) => {
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
      if (!accepted.includes(ext)) { hasInvalid = true; return; }
      const att = {
        id: crypto.randomUUID ? crypto.randomUUID() : `file-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        file,
        url: URL.createObjectURL(file)
      };
      this.attachments.push(att);
      added.push(att);
    });

    if (added.length > 0) {
      this.renderAttachments();
      const canSubmit = this.canSubmit();
      this.submitButton.disabled = !canSubmit;
      if (this.toolbarButton) this.toolbarButton.disabled = !canSubmit;
      this.autoResize();
    }

    if (hasInvalid) {
      this.statusEl.textContent = "仅支持上传 .stp 与 .msh 文件";
    }

    this.fileInput.value = "";
  }

  handleAttachmentRemove(e) {
    const btn = e.target.closest("[data-action=remove-attachment]");
    if (!btn) return;
    const id = btn.dataset.attachmentId;
    const idx = this.attachments.findIndex((x) => x.id === id);
    if (idx === -1) return;
    const [removed] = this.attachments.splice(idx, 1);
    if (removed?.url) URL.revokeObjectURL(removed.url);
    this.renderAttachments();
    const canSubmit = this.canSubmit();
    this.submitButton.disabled = !canSubmit;
    if (this.toolbarButton) this.toolbarButton.disabled = !canSubmit;
  }

  autoResize() {
    this.textarea.style.height = "auto";
    const maxHeight = 220;
    this.textarea.style.height = `${Math.min(this.textarea.scrollHeight, maxHeight)}px`;
  }

  canSubmit() {
    return Boolean(this.textarea.value.trim());
  }

  renderAttachments() {
    if (!this.attachments.length) {
      this.attachmentList.innerHTML = "";
      this.attachmentList.classList.remove("chat-input__attachments--visible");
      return;
    }
    this.attachmentList.classList.add("chat-input__attachments--visible");
    const frag = document.createDocumentFragment();

    this.attachments.forEach((it) => {
      const chip = document.createElement("div");
      chip.className = "chat-input__attachment";

      const name = document.createElement("span");
      name.className = "chat-input__attachment-name";
      name.textContent = it.file.name;

      const size = document.createElement("span");
      size.className = "chat-input__attachment-size";
      size.textContent = formatFileSize(it.file.size);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "chat-input__attachment-remove";
      remove.dataset.attachmentId = it.id;
      remove.setAttribute("aria-label", `移除附件 ${it.file.name}`);
      remove.innerHTML = icons.close;
      remove.dataset.action = "remove-attachment";

      chip.append(name, size, remove);
      frag.appendChild(chip);
    });

    this.attachmentList.innerHTML = "";
    this.attachmentList.appendChild(frag);
  }

  clearLocalAttachments(options = {}) {
    const { release = true } = options;
    if (release) {
      this.attachments.forEach((it) => { if (it.url) URL.revokeObjectURL(it.url); });
    }
    this.attachments = [];
    this.renderAttachments();
  }

  destroy() {
    this.form.removeEventListener("submit", this.handleSubmit);
    this.textarea.removeEventListener("input", this.handleInput);
    this.textarea.removeEventListener("keydown", this.handleKeyDown);
    this.attachButton.removeEventListener("click", this.handleAttachClick);
    this.fileInput.removeEventListener("change", this.handleFileChange);
    this.attachmentList.removeEventListener("click", this.handleAttachmentRemove);
    if (this.toolbarButton) this.toolbarButton.removeEventListener("click", this.handleGenerateClick);
    if (this.cancelButton) this.cancelButton.removeEventListener("click", this.handleCancel);

    try { this.activeController?.abort(); } catch {}
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.clearLocalAttachments();
    if (this.unsubscribe) this.unsubscribe();
  }
}
