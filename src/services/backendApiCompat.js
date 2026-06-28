import {
  getBackendStatus,
  healthCheck,
  optimizeText,
  transcribeAndOptimize,
  transcribeAudio,
  transcribeAudioStream
} from './asrApi.js';
import { getServiceStatus, loadService, unloadService } from './serviceControlApi.js';
import { loadTtsModel, planTtsChunks, speakText, unloadTtsModel } from './ttsApi.js';
import { translateText } from './translateApi.js';

export default {
  transcribeAudio,
  transcribeAudioStream,
  optimizeText,
  transcribeAndOptimize,
  getBackendStatus,
  getServiceStatus,
  healthCheck,
  speakText,
  translateText,
  planTtsChunks,
  loadTtsModel,
  unloadTtsModel,
  loadService,
  unloadService
};
