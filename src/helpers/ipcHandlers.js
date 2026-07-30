const { ipcMain } = require("electron");

const { forwardMonitorEvents, registerIpcHandlers } = require("../platform/electron/ipc/registerIpcHandlers");

class IPCHandlers {
  constructor(managers) {
    this.environmentManager = managers.environmentManager;
    this.databaseManager = managers.databaseManager;
    this.clipboardManager = managers.clipboardManager;
    this.windowManager = managers.windowManager;
    this.hotkeyManager = managers.hotkeyManager;
    this.logger = managers.logger;
    this.processMonitorManager = managers.processMonitorManager;
    this.linkBookmarkManager = managers.linkBookmarkManager;
    this.voiceDatasetRecorder = managers.voiceDatasetRecorder;
    this.asrConnectionProfiles = managers.asrConnectionProfiles;
    this.f2RegisteredSenders = new Set();

    registerIpcHandlers(this);
    forwardMonitorEvents(this);
  }

  emitSettingsUpdate(payload) {
    const windows = [this.windowManager.mainWindow, this.windowManager.settingsWindow];
    for (const win of windows) {
      if (win && !win.isDestroyed()) {
        win.webContents.send("settings-update", payload);
      }
    }
  }

  async processTextWithAI(text, mode = 'optimize') {
    try {
      const apiKey = await this.databaseManager.getSetting('ai_api_key');
      if (!apiKey) {
        return {
          success: false,
          error: '请先在设置页面配置AI API密钥'
        };
      }

      const prompts = {
        format: `请将以下文本进行格式化，添加适当的段落分隔，使其更易阅读：\n\n${text}`,
        correct: `请纠正以下文本中的语法错误、错别字和语音识别错误，保持原意不变：\n\n${text}`,
        optimize: `# 角色与目标
你是一个专业的语音转录文本优化助手，任务是对由ASR（自动语音识别）生成的初步文本进行精细的、最小化的润色。你的核心目标是去除言语组织过程中的干扰性噪音，同时100%保留说话人的原始意图、个人风格和口语习惯。

# 核心原则
- **最小化修改**：只处理明确的、非内容性的言语错误。
- **保留原貌**：最大限度地保留用户的原始用词、句式和语气。
- **可读性优先**：在不改变原意的前提下，提升文本的流畅性和可读性。
- **歧义时保守**：当不确定一个词或一句话是否需要修改时，必须选择保持原样。

# 明确的优化指令 (Do's)
1.  **纠正明显的拼写和语法错误**：修正同音错字、标点误用、以及基础的语法搭配错误（如主谓不一致）。
2.  **移除无意义的填充词**：删除如"呃"、"嗯"、"啊这"、"那个"、"内个"、"然后那个"、"就是说"等在思考或停顿时使用的、不承载实际信息的词语。
3.  **处理重复与口吃**：合并无意义的重复词语。
4.  **整合自我修正**：当用户明确表达了修正意图时，保留修正后的最终内容，并移除被修正的错误部分。

# 严格的禁止项 (Don'ts)
1.  **禁止风格转换**：绝不能将口语化的表达替换为更书面化的词语。
2.  **禁止替换用词**：除非是明显的错别字，否则不能改变用户的任何用词选择。
3.  **禁止改变句式**：不能为了"优化"而重组用户的句子结构。
4.  **禁止增删情感或语气词**：必须保留所有表达情感和语气的词。
5.  **禁止主观臆断**：不能添加任何原始文本中不存在的信息。

原始文本：
\`\`\`
${text}
\`\`\`

# 输出格式
- **输出**: 直接返回优化后的文本，不要包含任何解释、前言或总结。`,
        optimize_long: `# 角色与目标
你是一个专业的长文本整理助手，专门处理语音转录的长段内容。你的任务是清理口语化的思考过程，并对内容进行逻辑分段，让文本更加清晰易读。

原始文本：
\`\`\`
${text}
\`\`\`

请直接返回清理后并分段的文本，不要包含任何解释或说明。`,
        summarize: `请总结以下文本的主要内容，提取关键信息：\n\n${text}`,
        enhance: `请对以下文本进行内容优化：

**优化要求：**
1. **严格保持原意和语义不变**
2. 纠正明显的用词错误和语法问题
3. 优化表达方式，使语言更加准确和流畅
4. 可以调整标点符号以提升文本质量
5. 保留原文的语言风格

原始文本：
${text}

请直接返回优化后的文本，不需要解释过程。`
      };

      const baseUrl = await this.databaseManager.getSetting('ai_base_url') || 'https://api.openai.com/v1';
      const model = await this.databaseManager.getSetting('ai_model') || 'gpt-3.5-turbo';
      const requestData = {
        model,
        messages: [{ role: 'user', content: prompts[mode] || prompts.optimize }],
        temperature: 0.3,
        max_tokens: 2000,
        stream: false
      };

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestData)
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorData = { error: response.statusText };
        try {
          errorData = JSON.parse(errorText);
        } catch {
          errorData = { error: errorText || response.statusText };
        }
        throw new Error(errorData.error?.message || errorData.error || `API error: ${response.status}`);
      }

      const data = await response.json();
      if (data.choices && data.choices.length > 0) {
        return {
          success: true,
          text: data.choices[0].message.content.trim(),
          usage: data.usage,
          model
        };
      }
      return { success: false, error: 'AI API返回数据格式错误' };
    } catch (error) {
      this.logger.error('AI文本处理失败:', error);
      return { success: false, error: error.message || '未知错误' };
    }
  }

  async checkAIStatus(testConfig = null) {
    try {
      let apiKey;
      let baseUrl;
      let model;
      if (testConfig) {
        apiKey = testConfig.ai_api_key;
        baseUrl = testConfig.ai_base_url || 'https://api.openai.com/v1';
        model = testConfig.ai_model || 'gpt-3.5-turbo';
      } else {
        apiKey = await this.databaseManager.getSetting('ai_api_key');
        baseUrl = await this.databaseManager.getSetting('ai_base_url') || 'https://api.openai.com/v1';
        model = await this.databaseManager.getSetting('ai_model') || 'gpt-3.5-turbo';
      }
      if (!apiKey) {
        return { available: false, error: '未配置API密钥', details: '请输入AI API密钥' };
      }

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: '请回复"测试成功"来确认AI服务正常工作' }],
          max_tokens: 50,
          temperature: 0.1
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || `HTTP ${response.status}`);
      }

      const data = await response.json();
      const aiResponse = data.choices?.[0]?.message?.content || '';
      return {
        available: true,
        model,
        status: 'connected',
        response: aiResponse,
        usage: data.usage,
        details: `成功连接到 ${model}，响应时间正常`
      };
    } catch (error) {
      this.logger.error('AI配置测试失败:', error);
      return {
        available: false,
        error: error.message || '连接失败',
        details: `测试失败原因: ${error.message}`
      };
    }
  }

  removeAllHandlers() {
    ipcMain.removeAllListeners();
  }
}

module.exports = IPCHandlers;
