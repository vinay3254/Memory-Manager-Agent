// ============================================================
// src/store/config.ts
// Persistent configuration store for Memory Manager Agent.
// ============================================================

import { writeFileSync, readFileSync, existsSync } from "fs";

export interface ConfigData {
  STORE_THRESHOLD: number;
  COMPRESS_THRESHOLD: number;
  DECAY_RATE: number;
  MERGE_SIMILARITY_THRESHOLD: number;
}

const DEFAULT_CONFIG: ConfigData = {
  STORE_THRESHOLD: 0.70,
  COMPRESS_THRESHOLD: 0.35,
  DECAY_RATE: 0.03,
  MERGE_SIMILARITY_THRESHOLD: 0.60,
};

export class ConfigStore {
  private configPath: string;
  private config: ConfigData;

  constructor(configPath: string = "./data/config.json") {
    this.configPath = configPath;
    this.config = { ...DEFAULT_CONFIG };
    this.load();
  }

  private load(): void {
    if (existsSync(this.configPath)) {
      try {
        const raw = readFileSync(this.configPath, "utf-8");
        const parsed = JSON.parse(raw);
        this.config = { ...DEFAULT_CONFIG, ...parsed };
      } catch (err) {
        process.stderr.write(`[ConfigStore] Warning: Failed to load config, using defaults. ${String(err)}\n`);
      }
    } else {
      this.save();
    }
  }

  private save(): void {
    try {
      writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), "utf-8");
    } catch (err) {
      process.stderr.write(`[ConfigStore] Error: Failed to save config. ${String(err)}\n`);
    }
  }

  get<K extends keyof ConfigData>(key: K): ConfigData[K] {
    return this.config[key];
  }

  set<K extends keyof ConfigData>(key: K, value: ConfigData[K]): void {
    this.config[key] = value;
    this.save();
  }

  getAll(): ConfigData {
    return { ...this.config };
  }
}

let _configStore: ConfigStore | null = null;

export function getConfigStore(): ConfigStore {
  if (!_configStore) {
    _configStore = new ConfigStore();
  }
  return _configStore;
}
