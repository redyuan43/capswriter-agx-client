import { useState, useEffect, useCallback } from 'react';
import { getBackendStatus as fetchBackendStatus, getTtsHealth as fetchTtsHealth, isRealtimeASRConfigured } from '../services/backendAPI.js';

const isControlPanelOrSettings = () => {
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get('panel') === 'control' || urlParams.get('page') === 'settings';
};

const normalizePositiveInteger = (value, high = 8) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const integer = Math.floor(number);
  if (integer < 1) return null;
  return Math.max(1, Math.min(high, integer));
};

const createEmptyTtsSnapshot = () => ({
  ttsEnabled: false,
  ttsLoaded: false,
  ttsWarmed: false,
  ttsRemoteService: false,
  ttsWorkersReady: null,
  ttsRecommendedPrefetch: null
});

const createTtsSnapshot = (payload) => {
  const workersReady = normalizePositiveInteger(
    payload?.tts_parallel_workers_ready || payload?.tts_workers_ready || payload?.workers_ready,
    8
  );
  const recommendedPrefetch = normalizePositiveInteger(
    payload?.tts_recommended_prefetch_chunks || payload?.client_defaults?.recommended_prefetch_chunks,
    8
  );
  const status = String(payload?.status || '').toLowerCase();
  const loaded = payload?.tts_model_loaded === true || status === 'ready';
  return {
    ttsEnabled: payload?.tts_enabled === true || payload?.success === true || loaded,
    ttsLoaded: loaded,
    ttsWarmed: payload?.tts_warmed === true || loaded,
    ttsRemoteService: payload?.tts_remote_service === true || Boolean(payload?.tts_backend || payload?.api_version),
    ttsWorkersReady: workersReady,
    ttsRecommendedPrefetch: recommendedPrefetch
  };
};

const fetchRealtimeTtsSnapshot = async () => {
  try {
    return createTtsSnapshot(await fetchTtsHealth());
  } catch {
    return createEmptyTtsSnapshot();
  }
};

/**
 * 模型状态监控 Hook（优先 HTTP 后端，失败时可回退到实时 ASR）
 */
export const useModelStatus = () => {
  const [modelStatus, setModelStatus] = useState({
    isLoading: true,
    isReady: false,
    isDownloading: false,
    modelsDownloaded: true,
    error: null,
    progress: 0,
    downloadProgress: 0,
    missingModels: [],
    stage: 'checking',
    ttsEnabled: false,
    ttsLoaded: false,
    ttsWarmed: false,
    ttsRemoteService: false,
    ttsWorkersReady: null,
    ttsRecommendedPrefetch: null
  });

  const checkModelStatus = useCallback(async () => {
    if (isRealtimeASRConfigured()) {
      const ttsSnapshot = await fetchRealtimeTtsSnapshot();
      setModelStatus({
        isLoading: false,
        isReady: true,
        isDownloading: false,
        modelsDownloaded: true,
        error: null,
        progress: 100,
        downloadProgress: 0,
        missingModels: [],
        stage: 'ready',
        ...ttsSnapshot
      });
      return;
    }

    try {
      const backendStatus = await fetchBackendStatus();
      const ttsSnapshot = createTtsSnapshot(backendStatus);
      const asrService = backendStatus?.services?.asr || null;
      const asrStatus = String(asrService?.status || '').toLowerCase();
      const hasAsrService = Boolean(asrService);
      const asrManaged = hasAsrService && asrService?.managed !== false;
      const asrAvailable = ['idle', 'ready'].includes(asrStatus) || asrService?.loaded === true;
      const backendReachable = typeof backendStatus === 'object' && backendStatus !== null;
      const backendReady = backendStatus?.status === 'ready';
      const backendLoading =
        (hasAsrService && asrManaged && asrStatus === 'loading') ||
        (!hasAsrService && backendStatus?.status === 'loading' && !backendReady);

      if (backendLoading) {
        setModelStatus({
          isLoading: true,
          isReady: false,
          isDownloading: false,
          modelsDownloaded: true,
          error: null,
          progress: 50,
          downloadProgress: 0,
          missingModels: [],
          stage: 'loading',
          ...ttsSnapshot
        });
        return;
      }

      if (backendReady || (backendReachable && asrManaged && asrAvailable)) {
        setModelStatus({
          isLoading: false,
          isReady: true,
          isDownloading: false,
          modelsDownloaded: true,
          error: null,
          progress: 100,
          downloadProgress: 0,
          missingModels: [],
          stage: 'ready',
          ...ttsSnapshot
        });
        return;
      }

      setModelStatus({
        isLoading: false,
        isReady: false,
        isDownloading: false,
        modelsDownloaded: true,
        error: asrService?.error || '后端状态未知',
        progress: 0,
        downloadProgress: 0,
        missingModels: [],
        stage: 'error',
        ...ttsSnapshot
      });
    } catch (error) {
      if (isRealtimeASRConfigured()) {
        const ttsSnapshot = await fetchRealtimeTtsSnapshot();
        setModelStatus({
          isLoading: false,
          isReady: true,
          isDownloading: false,
          modelsDownloaded: true,
          error: null,
          progress: 100,
          downloadProgress: 0,
          missingModels: [],
          stage: 'ready',
          ...ttsSnapshot
        });
        return;
      }

      setModelStatus({
        isLoading: false,
        isReady: false,
        isDownloading: false,
        modelsDownloaded: true,
        error: error.message || '后端不可用',
        progress: 0,
        downloadProgress: 0,
        missingModels: [],
        stage: 'error',
        ttsEnabled: false,
        ttsLoaded: false,
        ttsWarmed: false,
        ttsRemoteService: false,
        ttsWorkersReady: null,
        ttsRecommendedPrefetch: null
      });
    }
  }, []);

  // 兼容旧调用方: 本地模型文件检查已废弃
  const checkModelFiles = useCallback(async () => ({
    success: true,
    models_downloaded: true,
    missing_models: [],
    disabled: true,
    mode: 'remote-backend'
  }), []);

  // 兼容旧调用方: 本地下载逻辑已废弃
  const downloadModels = useCallback(async () => ({
    success: false,
    disabled: true,
    error: '本地模型下载已移除，请启动 HTTP 后端服务'
  }), []);

  const getDownloadProgress = useCallback(async () => ({
    success: true,
    progress: 100,
    disabled: true
  }), []);

  useEffect(() => {
    if (isControlPanelOrSettings()) {
      return;
    }
    checkModelStatus();
  }, [checkModelStatus]);

  useEffect(() => {
    if (isControlPanelOrSettings() || modelStatus.isReady) {
      return;
    }

    const interval = setInterval(() => {
      if (!modelStatus.isReady) {
        checkModelStatus();
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [modelStatus.isReady, checkModelStatus]);

  return {
    ...modelStatus,
    checkModelStatus,
    downloadModels,
    getDownloadProgress,
    checkModelFiles
  };
};
