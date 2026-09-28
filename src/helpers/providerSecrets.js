const fs = require('fs');
const path = require('path');

const FIELDS = ['glmApiKey', 'tencentAppId', 'tencentSecretId', 'tencentSecretKey'];

// 密钥只在主进程解密；设置页只能读取是否已配置。
class ProviderSecrets {
  constructor({ dataDirectory, safeStorage, env = process.env }) {
    this.filePath = path.join(dataDirectory, 'provider-secrets.json');
    this.safeStorage = safeStorage;
    this.env = env;
  }

  canEncrypt() {
    return !!this.safeStorage?.isEncryptionAvailable() &&
      this.safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
  }

  read() {
    if (!fs.existsSync(this.filePath)) return {};
    if (!this.canEncrypt()) throw new Error('系统密钥环不可用，无法读取凭据');
    const stored = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    return JSON.parse(this.safeStorage.decryptString(Buffer.from(stored.encrypted, 'base64')));
  }

  get() {
    const saved = this.read();
    return {
      glmApiKey: this.env.ZHIPU_API_KEY || this.env.GLM_API_KEY || saved.glmApiKey || '',
      tencentAppId: this.env.TENCENTCLOUD_APP_ID || saved.tencentAppId || '',
      tencentSecretId: this.env.TENCENTCLOUD_SECRET_ID || saved.tencentSecretId || '',
      tencentSecretKey: this.env.TENCENTCLOUD_SECRET_KEY || saved.tencentSecretKey || '',
    };
  }

  status() {
    try {
      const values = this.get();
      return { secureStorage: this.canEncrypt(), configured: Object.fromEntries(FIELDS.map((key) => [key, !!values[key]])) };
    } catch {
      return { secureStorage: false, configured: {}, error: '系统密钥环不可用，无法读取凭据' };
    }
  }

  save(patch) {
    if (!this.canEncrypt()) throw new Error('系统密钥环不可用，拒绝明文保存密钥');
    const next = this.read();
    for (const key of FIELDS) {
      if (!Object.hasOwn(patch, key)) continue;
      const value = String(patch[key] || '').trim();
      if (value.length > 4096 || /[\r\n\0]/.test(value)) throw new Error('凭据格式无效');
      if (key === 'tencentAppId' && value && !/^\d+$/.test(value)) throw new Error('腾讯 AppId 必须为数字');
      next[key] = value;
    }
    const body = JSON.stringify({ version: 1, encrypted: this.safeStorage.encryptString(JSON.stringify(next)).toString('base64') });
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, body, { mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
    return this.status();
  }
}

module.exports = { ProviderSecrets };
