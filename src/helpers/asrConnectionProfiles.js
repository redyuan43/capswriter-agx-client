const fs = require("fs");
const path = require("path");

const PROFILE_SETTING_KEY = "asr_connection_profiles_v1";
const SECRET_FILE_NAME = "asr-connection-secrets.json";
const PUBLIC_ASR_URL = "wss://asr.yuanspaces.com/api/asr/realtime";

const PRESETS = [
  { id: "spark", name: "Spark", url: "ws://spark-31d6.taild500c8.ts.net:18011/api/asr/realtime", auth: "none", preset: true },
  { id: "public", name: "公网", url: PUBLIC_ASR_URL, auth: "token", preset: true },
  { id: "agx", name: "AGX", url: "ws://agx.taild500c8.ts.net:18011/api/asr/realtime", auth: "none", preset: true },
];

function cleanUrl(value) {
  const raw = String(value || "").trim();
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "ws:" || parsed.protocol === "wss:" ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function clonePreset(profile) {
  return { ...profile };
}

function defaultConfig() {
  return { version: 1, activeProfileId: "public", profiles: PRESETS.map(clonePreset) };
}

function normalizeProfile(profile, existing = null) {
  const preset = PRESETS.find((item) => item.id === profile?.id);
  const id = preset ? preset.id : String(profile?.id || existing?.id || "").trim();
  if (!id || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error("ASR 配置标识无效");
  const name = preset ? preset.name : String(profile?.name || existing?.name || "").trim();
  if (!name || name.length > 40) throw new Error("ASR 配置名称无效");
  const url = cleanUrl(profile?.url ?? existing?.url);
  if (!url) throw new Error("ASR 地址必须是有效的 ws:// 或 wss:// 地址");
  const auth = preset ? preset.auth : (profile?.auth === "token" ? "token" : "none");
  return { id, name, url, auth, preset: Boolean(preset) };
}

function normalizeConfig(value) {
  const defaults = defaultConfig();
  if (!value || typeof value !== "object" || !Array.isArray(value.profiles)) return defaults;
  const byId = new Map(value.profiles.map((item) => [item?.id, item]));
  const profiles = PRESETS.map((preset) => {
    try {
      return normalizeProfile({ ...preset, ...(byId.get(preset.id) || {}) }, preset);
    } catch {
      return clonePreset(preset);
    }
  });
  const names = new Set(profiles.map((item) => item.name.toLocaleLowerCase()));
  for (const candidate of value.profiles) {
    if (PRESETS.some((preset) => preset.id === candidate?.id)) continue;
    try {
      const profile = normalizeProfile(candidate);
      if (names.has(profile.name.toLocaleLowerCase()) || profiles.some((item) => item.id === profile.id)) continue;
      names.add(profile.name.toLocaleLowerCase());
      profiles.push(profile);
    } catch {
      // Ignore malformed historical custom entries rather than breaking startup.
    }
  }
  const activeProfileId = profiles.some((item) => item.id === value.activeProfileId)
    ? value.activeProfileId
    : defaults.activeProfileId;
  return { version: 1, activeProfileId, profiles };
}

class AsrConnectionProfiles {
  constructor({ databaseManager, dataDirectory, safeStorage, env = process.env, logger = null }) {
    this.databaseManager = databaseManager;
    this.dataDirectory = dataDirectory;
    this.safeStorage = safeStorage;
    this.env = env;
    this.logger = logger;
    this.initialized = false;
  }

  secretPath() {
    return path.join(this.dataDirectory, SECRET_FILE_NAME);
  }

  secureStorageStatus() {
    try {
      const available = Boolean(this.safeStorage?.isEncryptionAvailable?.());
      const backend = this.safeStorage?.getSelectedStorageBackend?.() || "unknown";
      return {
        available: available && backend !== "basic_text",
        backend,
        message: available && backend !== "basic_text" ? "系统安全存储可用" : "系统安全存储不可用，不能保存令牌",
      };
    } catch {
      return { available: false, backend: "unknown", message: "系统安全存储不可用，不能保存令牌" };
    }
  }

  readConfig() {
    return normalizeConfig(this.databaseManager.getSetting(PROFILE_SETTING_KEY, null));
  }

  writeConfig(config) {
    this.databaseManager.setSetting(PROFILE_SETTING_KEY, normalizeConfig(config));
  }

  readSecrets() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.secretPath(), "utf8"));
      return parsed && typeof parsed === "object" && parsed.tokens && typeof parsed.tokens === "object"
        ? { version: 1, tokens: parsed.tokens, cleared: parsed.cleared || {} }
        : { version: 1, tokens: {}, cleared: {} };
    } catch {
      return { version: 1, tokens: {}, cleared: {} };
    }
  }

  writeSecrets(secrets) {
    fs.mkdirSync(this.dataDirectory, { recursive: true, mode: 0o700 });
    const target = this.secretPath();
    const temporary = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, JSON.stringify(secrets), { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, target);
    fs.chmodSync(target, 0o600);
  }

  readStoredToken(profileId) {
    const encoded = this.readSecrets().tokens[profileId];
    if (!encoded || !this.secureStorageStatus().available) return "";
    try {
      return this.safeStorage.decryptString(Buffer.from(encoded, "base64"));
    } catch {
      return "";
    }
  }

  writeStoredToken(profileId, token) {
    const status = this.secureStorageStatus();
    if (!status.available) throw new Error(status.message);
    const secrets = this.readSecrets();
    secrets.tokens[profileId] = this.safeStorage.encryptString(token).toString("base64");
    delete secrets.cleared[profileId];
    this.writeSecrets(secrets);
  }

  clearStoredToken(profileId, { suppressRuntime = false } = {}) {
    const secrets = this.readSecrets();
    delete secrets.tokens[profileId];
    if (suppressRuntime) secrets.cleared[profileId] = true;
    else delete secrets.cleared[profileId];
    this.writeSecrets(secrets);
  }

  legacyUrl() {
    return cleanUrl(this.env.CAPSWRITER_REALTIME_ASR_URL)
      || cleanUrl(this.env.VITE_REALTIME_ASR_URL)
      || cleanUrl(this.databaseManager.getSetting("realtime_asr_url", ""));
  }

  initialize() {
    if (this.initialized) return;
    const existing = this.databaseManager.getSetting(PROFILE_SETTING_KEY, null);
    if (!existing) {
      const config = defaultConfig();
      const legacyUrl = this.legacyUrl();
      if (legacyUrl) {
        const matched = config.profiles.find((item) => item.url === legacyUrl);
        if (matched) {
          config.activeProfileId = matched.id;
        } else {
          config.profiles.push({ id: "migrated", name: "迁移的 ASR 路由", url: legacyUrl, auth: "token", preset: false });
          config.activeProfileId = "migrated";
        }
      }
      this.writeConfig(config);
      const active = config.profiles.find((item) => item.id === config.activeProfileId);
      const legacyToken = String(this.env.CAPSWRITER_REALTIME_ASR_TOKEN || "").trim();
      if (active?.auth === "token" && legacyToken && this.secureStorageStatus().available) {
        this.writeStoredToken(active.id, legacyToken);
      }
    }
    this.initialized = true;
  }

  list() {
    this.initialize();
    const config = this.readConfig();
    const secrets = this.readSecrets();
    return {
      activeProfileId: config.activeProfileId,
      profiles: config.profiles.map((profile) => ({
        ...profile,
        hasToken: Boolean(secrets.tokens[profile.id]) || (
          profile.auth === "token"
          && !secrets.cleared[profile.id]
          && Boolean(this.env.CAPSWRITER_REALTIME_ASR_TOKEN)
        ),
      })),
      secureStorage: this.secureStorageStatus(),
    };
  }

  getActiveConnection() {
    this.initialize();
    const config = this.readConfig();
    const profile = config.profiles.find((item) => item.id === config.activeProfileId) || config.profiles[0];
    let token = "";
    if (profile.auth === "token") {
      const secrets = this.readSecrets();
      token = this.readStoredToken(profile.id) || (
        secrets.cleared[profile.id] ? "" : String(this.env.CAPSWRITER_REALTIME_ASR_TOKEN || "").trim()
      );
    }
    return { id: profile.id, name: profile.name, url: profile.url, token };
  }

  getConnectionForProfile(profile, { token, clearToken = false } = {}) {
    this.initialize();
    const config = this.readConfig();
    const existing = config.profiles.find((item) => item.id === profile?.id) || null;
    const normalized = normalizeProfile(profile, existing);
    const suppliedToken = typeof token === "string" ? token.trim() : "";
    const secrets = this.readSecrets();
    const resolvedToken = normalized.auth === "token"
      ? (suppliedToken || (clearToken ? "" : this.readStoredToken(normalized.id)) || ((clearToken || secrets.cleared[normalized.id]) ? "" : String(this.env.CAPSWRITER_REALTIME_ASR_TOKEN || "").trim()))
      : "";
    return { id: normalized.id, name: normalized.name, url: normalized.url, token: resolvedToken };
  }

  save(profile, { token, clearToken = false } = {}) {
    this.initialize();
    const config = this.readConfig();
    const existing = config.profiles.find((item) => item.id === profile?.id) || null;
    const next = normalizeProfile(profile, existing);
    const duplicateName = config.profiles.find((item) => item.id !== next.id && item.name.toLocaleLowerCase() === next.name.toLocaleLowerCase());
    if (duplicateName) throw new Error("ASR 配置名称已存在");
    const index = config.profiles.findIndex((item) => item.id === next.id);
    if (index >= 0) config.profiles[index] = next;
    else config.profiles.push(next);
    if (next.auth !== "token") this.clearStoredToken(next.id);
    if (next.auth === "token" && clearToken) this.clearStoredToken(next.id, { suppressRuntime: true });
    if (next.auth === "token" && typeof token === "string" && token.trim()) this.writeStoredToken(next.id, token.trim());
    this.writeConfig(config);
    return this.list();
  }

  remove(profileId) {
    this.initialize();
    if (PRESETS.some((item) => item.id === profileId)) throw new Error("预置 ASR 配置不能删除");
    const config = this.readConfig();
    if (!config.profiles.some((item) => item.id === profileId)) throw new Error("ASR 配置不存在");
    if (config.activeProfileId === profileId) throw new Error("不能删除当前正在使用的 ASR 配置");
    config.profiles = config.profiles.filter((item) => item.id !== profileId);
    this.clearStoredToken(profileId);
    this.writeConfig(config);
    return this.list();
  }

  activate(profileId) {
    this.initialize();
    const config = this.readConfig();
    if (!config.profiles.some((item) => item.id === profileId)) throw new Error("ASR 配置不存在");
    config.activeProfileId = profileId;
    this.writeConfig(config);
    return this.list();
  }
}

module.exports = {
  AsrConnectionProfiles,
  PRESETS,
  PROFILE_SETTING_KEY,
  cleanUrl,
  normalizeConfig,
};
