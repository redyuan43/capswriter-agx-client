import backendConfig from '../config/backend.js';
import { TTS_CONTROL_REQUEST_TIMEOUT_MS, apiClient, callJsonControl, getBaseURL } from './sharedClient.js';

export async function getServiceStatus() {
  const response = await apiClient.get(`${await getBaseURL()}${backendConfig.endpoints.servicesStatus}`);
  return response.data;
}

export async function loadService(serviceName, options = {}) {
  return callJsonControl(
    backendConfig.endpoints.serviceLoad(serviceName),
    TTS_CONTROL_REQUEST_TIMEOUT_MS,
    'Service control request',
    options
  );
}

export async function unloadService(serviceName, options = {}) {
  return callJsonControl(
    backendConfig.endpoints.serviceUnload(serviceName),
    TTS_CONTROL_REQUEST_TIMEOUT_MS,
    'Service control request',
    options
  );
}
