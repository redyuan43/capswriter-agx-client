// 同一录音的交付复用进行中的请求；下一次录音即使文本相同也应正常输入。
export function createTextDelivery() {
  let previous = null;
  return async (text, generation, deliver) => {
    if (previous?.text === text && previous.generation === generation) return previous.promise;
    const entry = { text, generation };
    entry.promise = Promise.resolve().then(deliver).then((result) => {
      if (!result.ok && previous === entry) previous = null;
      return result;
    }, () => {
      if (previous === entry) previous = null;
      return { ok: false, mode: 'failed' };
    });
    previous = entry;
    return entry.promise;
  };
}
