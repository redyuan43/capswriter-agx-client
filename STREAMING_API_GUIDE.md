# 🌊 语音转写 Backend 流式API使用指南

## 概述

新增的流式API端点 `/api/asr/transcribe-and-optimize-stream` 提供了**实时的、分阶段的**语音识别和文本优化结果，让客户端能够及时展示处理进度。

## 与传统API的区别

### 传统API (`/api/asr/transcribe-and-optimize`)
```
客户端 → 上传音频 → [等待...] → 一次性返回所有结果
```
- ✅ 简单易用
- ❌ 用户需要等待整个处理完成才能看到结果
- ❌ 无法展示处理进度

### 流式API (`/api/asr/transcribe-and-optimize-stream`)
```
客户端 → 上传音频 → 实时接收处理阶段 → 逐步显示结果
         ↓
    阶段1: 开始处理
    阶段2: ASR识别完成
    阶段3: 正在优化
    阶段4: 优化完成
    阶段5: 处理完成
```
- ✅ 实时反馈
- ✅ 用户体验更好
- ✅ 可以展示处理进度

---

## API规范

### 端点信息

- **URL**: `http://localhost:8000/api/asr/transcribe-and-optimize-stream`
- **方法**: `POST`
- **Content-Type**: `multipart/form-data`
- **响应格式**: `text/event-stream` (Server-Sent Events)

### 请求参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `audio` | File | ✅ | - | 音频文件（支持wav, mp3, m4a等） |
| `use_vad` | Boolean | ❌ | true | 是否使用VAD（语音活动检测） |
| `use_punc` | Boolean | ❌ | true | 是否添加标点符号 |
| `hotword` | String | ❌ | "" | 自定义热词（空格分隔） |
| `optimize_mode` | String | ❌ | "optimize" | 优化模式（optimize/none） |

### 响应阶段

流式API会返回5个阶段的数据（每个阶段都是独立的JSON对象）：

#### 1️⃣ 阶段1：开始处理
```json
{
  "stage": "start",
  "message": "开始处理音频",
  "timestamp": 1234567890.123
}
```

#### 2️⃣ 阶段2：ASR识别完成
```json
{
  "stage": "asr_complete",
  "text": "我想使用Qwen和Docker",
  "duration": 2.5,
  "timestamp": 1234567892.456
}
```

#### 3️⃣ 阶段3：正在优化
```json
{
  "stage": "optimizing",
  "message": "正在优化文本"
}
```

#### 4️⃣ 阶段4：优化完成
```json
{
  "stage": "optimize_complete",
  "text": "我想使用Qwen和Docker",
  "timestamp": 1234567895.789
}
```

#### 5️⃣ 阶段5：处理完成
```json
{
  "stage": "done",
  "message": "处理完成",
  "asr_text": "我想使用Qwen和Docker",
  "optimized_text": "我想使用Qwen和Docker",
  "timestamp": 1234567895.790
}
```

#### ❌ 错误阶段
```json
{
  "stage": "error",
  "error": "错误信息"
}
```

---

## 客户端实现示例

### 1. Python客户端（推荐）

使用项目中的测试脚本：

```bash
cd /data/deepresearch/speech_transcription_backend
python test_stream_api.py test.wav
```

查看源代码：`test_stream_api.py`

### 2. JavaScript/浏览器客户端

**方法A：使用Fetch API**

```javascript
async function uploadAudio(audioFile) {
    const formData = new FormData();
    formData.append('audio', audioFile);
    formData.append('use_vad', 'true');
    formData.append('use_punc', 'true');

    const response = await fetch('http://localhost:8000/api/asr/transcribe-and-optimize-stream', {
        method: 'POST',
        body: formData
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');

        for (const line of lines) {
            if (line.startsWith('data: ')) {
                const data = JSON.parse(line.substring(6));
                handleStage(data);
            }
        }
    }
}

function handleStage(data) {
    switch (data.stage) {
        case 'start':
            console.log('🚀 开始处理');
            break;
        case 'asr_complete':
            console.log('🎤 ASR:', data.text);
            break;
        case 'optimizing':
            console.log('⚙️ 正在优化...');
            break;
        case 'optimize_complete':
            console.log('✨ 优化完成:', data.text);
            break;
        case 'done':
            console.log('✅ 完成!', data);
            break;
        case 'error':
            console.error('❌ 错误:', data.error);
            break;
    }
}
```

**方法B：使用HTML测试页面**

```bash
# 在浏览器中打开测试页面
xdg-open /data/deepresearch/speech_transcription_backend/test_stream_client.html
# 或访问: file:///data/deepresearch/speech_transcription_backend/test_stream_client.html
```

### 3. curl测试

```bash
curl -X POST http://localhost:8000/api/asr/transcribe-and-optimize-stream \
  -F "audio=@test.wav" \
  -F "use_vad=true" \
  -F "use_punc=true" \
  --no-buffer
```

---

## 集成到语音转写客户端

### Electron主进程示例

```javascript
const FormData = require('form-data');
const fetch = require('node-fetch');

async function transcribeWithStream(audioFilePath) {
    const formData = new FormData();
    formData.append('audio', fs.createReadStream(audioFilePath));
    formData.append('use_vad', 'true');
    formData.append('use_punc', 'true');

    const response = await fetch('http://192.168.100.38:8000/api/asr/transcribe-and-optimize-stream', {
        method: 'POST',
        body: formData
    });

    // 逐行读取SSE流
    const lines = response.body.pipe(split());

    for await (const line of lines) {
        if (line.startsWith('data: ')) {
            const data = JSON.parse(line.substring(6));

            // 发送到渲染进程
            mainWindow.webContents.send('transcription-stage', data);
        }
    }
}
```

### 渲染进程示例

```javascript
// 监听流式更新
ipcRenderer.on('transcription-stage', (event, data) => {
    const { stage } = data;

    if (stage === 'start') {
        showProgress('正在处理...');
    } else if (stage === 'asr_complete') {
        updateTranscription(data.text);
    } else if (stage === 'optimizing') {
        showProgress('正在优化...');
    } else if (stage === 'optimize_complete') {
        updateOptimizedText(data.text);
    } else if (stage === 'done') {
        hideProgress();
        showFinalResult(data.asr_text, data.optimized_text);
    }
});
```

---

## 性能特点

### 延迟对比

| 阶段 | 传统API | 流式API | 用户感知 |
|------|---------|---------|----------|
| ASR识别 | ~2秒 | ~2秒 | ✅ 立即看到识别结果 |
| LLM优化 | ~3秒 | ~3秒 | ✅ 看到优化进度提示 |
| 总时长 | ~5秒 | ~5秒 | ✅ 体验更流畅 |

**关键优势**：
- 传统API：用户等待5秒后一次性看到结果
- 流式API：用户在2秒时就能看到ASR结果，然后看到优化进度

---

## 注意事项

1. **网络缓冲**
   - 确保nginx/代理没有缓冲SSE响应
   - 响应头已包含 `X-Accel-Buffering: no`

2. **错误处理**
   - 流式API会在任何阶段出错时发送 `error` stage
   - 客户端应该监听 `error` stage 并妥善处理

3. **连接超时**
   - 默认无超时限制
   - 如需设置超时，可在客户端配置

4. **并发限制**
   - 流式API和传统API共享FunASR实例
   - 建议同时处理的请求不超过5个

---

## 故障排查

### 问题1：收不到流式数据

**检查**：
```bash
# 测试服务是否可用
curl http://localhost:8000/api/health

# 检查端点列表
curl http://localhost:8000/ | python3 -m json.tool

# 测试流式端点
curl -X POST http://localhost:8000/api/asr/transcribe-and-optimize-stream \
  -F "audio=@test.wav" --no-buffer
```

### 问题2：数据被缓冲

**原因**：nginx或代理服务器缓冲了SSE响应

**解决**：
- 确保响应头包含 `X-Accel-Buffering: no`
- 在nginx配置中禁用缓冲：
  ```nginx
  proxy_buffering off;
  ```

### 问题3：JSON解析错误

**原因**：SSE数据可能跨多个chunk传输

**解决**：
- 按行分割chunk
- 只处理以 `data: ` 开头的行
- 使用try-catch包裹JSON.parse

---

## API文档

完整的API文档可在以下位置查看：

- **Swagger UI**: http://localhost:8000/docs
- **ReDoc**: http://localhost:8000/redoc

---

## 示例代码位置

```
/data/deepresearch/speech_transcription_backend/
├── server.py                        # 流式API实现（第502-632行）
├── test_stream_api.py               # Python测试客户端
├── test_stream_client.html          # HTML测试页面
└── STREAMING_API_GUIDE.md           # 本文档
```

---

## 反馈与支持

如有问题或建议，请：
1. 查看服务日志：`docker-compose logs -f speech-transcription-backend`
2. 检查GPU状态：`nvidia-smi`
3. 查看API状态：`curl http://localhost:8000/api/status`

---

**最后更新**: 2025-10-16
