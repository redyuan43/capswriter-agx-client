// src/config/backend.js
/**
 * 语音转写后端API配置
 * 用于连接本地 CapsWriter HTTP API 服务
 */

// API端点配置
const ENDPOINTS = {
  health: '/api/health',
  status: '/api/status',
  servicesStatus: '/api/services/status',
  transcribe: '/api/asr/transcribe',
  learnHotwords: '/api/hotwords/learn',
  optimize: '/api/llm/optimize',
  transcribeAndOptimize: '/api/asr/transcribe-and-optimize',
  transcribeAndOptimizeStream: '/api/asr/transcribe-and-optimize-stream',
  textTranslate: '/api/text/translate',
  ttsSpeak: '/api/tts/speak',
  ttsHealth: '/api/ttshealth',
  ttsPlan: '/api/tts/plan',
  ttsLoad: '/api/tts/load',
  ttsUnload: '/api/tts/unload',
  serviceLoad: (serviceName) => `/api/services/${serviceName}/load`,
  serviceUnload: (serviceName) => `/api/services/${serviceName}/unload`
};

// 基础配置
const config = {
  baseURL: (import.meta.env.VITE_BACKEND_URL || '').trim(),
  ttsBaseURL: (import.meta.env.VITE_TTS_BASE_URL || import.meta.env.VITE_BACKEND_URL || '').trim(),
  timeout: 30000,
  endpoints: ENDPOINTS
};

export default config;

// 辅助函数：获取完整URL
export function getEndpointURL(endpointName) {
  return config.baseURL + config.endpoints[endpointName];
}

// 辅助函数：检查后端健康状态
export async function checkBackendHealth() {
  try {
    const response = await fetch(getEndpointURL('health'), {
      method: 'GET'
    });
    return response.ok;
  } catch (error) {
    console.error('Backend health check failed:', error);
    return false;
  }
}
