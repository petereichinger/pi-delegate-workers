import { createScopedJsonStore } from "pi-scoped-config";

export const PROFILE_NAMES = ["fast", "balanced", "deep"] as const;
export type ProfileName = (typeof PROFILE_NAMES)[number];

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export type DelegateProfileConfig = {
  model?: string | null;
  thinkingLevel?: ThinkingLevel | null;
};

export type DelegateConfig = {
  version?: 1;
  defaultProfile?: ProfileName;
  profiles?: Partial<Record<ProfileName, DelegateProfileConfig>>;
};

export type ResolvedDelegateConfig = {
  version: 1;
  defaultProfile: ProfileName;
  profiles: Record<ProfileName, DelegateProfileConfig>;
};

export type LoadedDelegateConfig = {
  config: ResolvedDelegateConfig;
  warnings: readonly string[];
  paths: {
    global: string;
    repo?: string;
    directory?: string;
  };
};

const PROFILE_NAME_SET = new Set<string>(PROFILE_NAMES);
const THINKING_LEVEL_SET = new Set<string>(THINKING_LEVELS);
const ROOT_FIELDS = new Set(["version", "defaultProfile", "profiles"]);
const PROFILE_FIELDS = new Set(["model", "thinkingLevel"]);

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function decodeDelegateConfig(value: unknown): {
  value: DelegateConfig;
  warnings: string[];
} {
  const root = objectValue(value, "config");
  const warnings = Object.keys(root)
    .filter((field) => !ROOT_FIELDS.has(field))
    .map((field) => `unknown root field ignored: ${field}`);
  const config: DelegateConfig = {};

  if (root.version !== undefined) {
    if (root.version !== 1) throw new TypeError("version must be 1");
    config.version = 1;
  }

  if (root.defaultProfile !== undefined) {
    if (
      typeof root.defaultProfile !== "string" ||
      !PROFILE_NAME_SET.has(root.defaultProfile)
    ) {
      throw new TypeError(
        `defaultProfile must be one of: ${PROFILE_NAMES.join(", ")}`,
      );
    }
    config.defaultProfile = root.defaultProfile as ProfileName;
  }

  if (root.profiles !== undefined) {
    const profiles = objectValue(root.profiles, "profiles");
    config.profiles = {};
    for (const [name, rawProfile] of Object.entries(profiles)) {
      if (!PROFILE_NAME_SET.has(name)) {
        warnings.push(`unknown profile ignored: ${name}`);
        continue;
      }

      const profile = objectValue(rawProfile, `profiles.${name}`);
      for (const field of Object.keys(profile)) {
        if (!PROFILE_FIELDS.has(field)) {
          warnings.push(`unknown profiles.${name} field ignored: ${field}`);
        }
      }

      const decoded: DelegateProfileConfig = {};
      if (profile.model !== undefined) {
        if (profile.model === null) {
          decoded.model = null;
        } else if (
          typeof profile.model === "string" &&
          /^[^/\s]+\/[^/\s][^\s]*$/.test(profile.model)
        ) {
          decoded.model = profile.model;
        } else {
          throw new TypeError(
            `profiles.${name}.model must be null or a provider/model string`,
          );
        }
      }

      if (profile.thinkingLevel !== undefined) {
        if (profile.thinkingLevel === null) {
          decoded.thinkingLevel = null;
        } else if (
          typeof profile.thinkingLevel === "string" &&
          THINKING_LEVEL_SET.has(profile.thinkingLevel)
        ) {
          decoded.thinkingLevel = profile.thinkingLevel as ThinkingLevel;
        } else {
          throw new TypeError(
            `profiles.${name}.thinkingLevel must be null or one of: ${THINKING_LEVELS.join(", ")}`,
          );
        }
      }

      config.profiles[name as ProfileName] = decoded;
    }
  }

  return { value: config, warnings };
}

export function mergeDelegateConfigs(
  configs: Array<DelegateConfig | undefined>,
): ResolvedDelegateConfig {
  const merged: ResolvedDelegateConfig = {
    version: 1,
    defaultProfile: "balanced",
    profiles: {
      fast: {},
      balanced: {},
      deep: {},
    },
  };

  for (const config of configs) {
    if (!config) continue;
    if (config.defaultProfile) merged.defaultProfile = config.defaultProfile;
    for (const profileName of PROFILE_NAMES) {
      const profile = config.profiles?.[profileName];
      if (!profile) continue;
      if (Object.hasOwn(profile, "model")) {
        merged.profiles[profileName].model = profile.model;
      }
      if (Object.hasOwn(profile, "thinkingLevel")) {
        merged.profiles[profileName].thinkingLevel = profile.thinkingLevel;
      }
    }
  }

  return merged;
}

export function createDelegateConfigLoader(options: {
  agentDir?: string | (() => string);
  configDirName?: string;
} = {}) {
  const store = createScopedJsonStore<DelegateConfig>({
    name: "delegate-workers",
    decode: decodeDelegateConfig,
    ...options,
  });

  return {
    invalidate: () => store.invalidate(),
    async load(ctx: {
      cwd: string;
      isProjectTrusted?: () => boolean;
    }): Promise<LoadedDelegateConfig> {
      const scoped = await store.load({
        cwd: ctx.cwd,
        projectTrusted:
          typeof ctx.isProjectTrusted === "function" &&
          ctx.isProjectTrusted(),
      });
      if (scoped.errors.length > 0) {
        throw new Error(`delegate-workers config errors:\n${scoped.errors.join("\n")}`);
      }

      return {
        config: mergeDelegateConfigs([
          scoped.global.value as DelegateConfig | undefined,
          scoped.repo?.value as DelegateConfig | undefined,
          scoped.directory?.value as DelegateConfig | undefined,
        ]),
        warnings: scoped.warnings,
        paths: {
          global: scoped.global.sourcePath ?? scoped.global.writePath,
          ...(scoped.repo
            ? { repo: scoped.repo.sourcePath ?? scoped.repo.writePath }
            : {}),
          ...(scoped.directory
            ? {
                directory:
                  scoped.directory.sourcePath ?? scoped.directory.writePath,
              }
            : {}),
        },
      };
    },
  };
}

export const delegateConfigLoader = createDelegateConfigLoader();
