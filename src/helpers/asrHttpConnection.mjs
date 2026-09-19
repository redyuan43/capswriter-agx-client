// ASR profiles may override HTTP routing without moving LLM or TTS requests.
export async function resolveAsrHttpBaseURL(getActiveConnection, getLegacyBaseURL) {
  if (typeof getActiveConnection === 'function') {
    const active = await getActiveConnection();
    if (active?.httpBaseUrl) {
      const url = new URL(active.httpBaseUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('ASR HTTP 地址无效');
      }
      return url.toString().replace(/\/+$/, '');
    }
  }
  return getLegacyBaseURL();
}
