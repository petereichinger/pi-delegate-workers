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

export type DelegateTierConfig = {
  id: string;
  model: string;
  thinkingLevel?: ThinkingLevel;
  advisorOnly?: boolean;
};

export type DelegateModelSetConfig = {
  tiers?: DelegateTierConfig[];
  profiles?: Partial<Record<ProfileName, DelegateProfileConfig>>;
  profileTiers?: Partial<Record<ProfileName, string>>;
};

export type ParentModelRoute = {
  models: string[];
  modelSet: string;
};

export type DelegateConfig = {
  version?: 1;
  defaultProfile?: ProfileName;
  profiles?: Partial<Record<ProfileName, DelegateProfileConfig>>;
  defaultModelSet?: string | null;
  modelSets?: Record<string, DelegateModelSetConfig | null>;
  parentModelRoutes?: ParentModelRoute[] | null;
};

export type ResolvedDelegateConfig = {
  version: 1;
  defaultProfile: ProfileName;
  profiles: Record<ProfileName, DelegateProfileConfig>;
  defaultModelSet?: string;
  modelSets: Record<string, DelegateModelSetConfig>;
  parentModelRoutes: ParentModelRoute[];
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
const ROOT_FIELDS = new Set([
  "version",
  "defaultProfile",
  "profiles",
  "defaultModelSet",
  "modelSets",
  "parentModelRoutes",
]);
const PROFILE_FIELDS = new Set(["model", "thinkingLevel"]);
const MODEL_SET_FIELDS = new Set(["profiles", "tiers"]);
const TIER_FIELDS = new Set(["id", "model", "thinkingLevel", "advisorOnly"]);
const ROUTE_FIELDS = new Set(["models", "modelSet"]);
const MODEL_SET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MODEL_PATTERN = /^[^/\s]+\/[^/\s][^\s]*$/;

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function decodeProfile(
  rawProfile: unknown,
  label: string,
  warnings: string[],
): DelegateProfileConfig {
  const profile = objectValue(rawProfile, label);
  for (const field of Object.keys(profile)) {
    if (!PROFILE_FIELDS.has(field)) {
      warnings.push(`unknown ${label} field ignored: ${field}`);
    }
  }

  const decoded: DelegateProfileConfig = {};
  if (profile.model !== undefined) {
    if (profile.model === null) {
      decoded.model = null;
    } else if (
      typeof profile.model === "string" &&
      MODEL_PATTERN.test(profile.model)
    ) {
      decoded.model = profile.model;
    } else {
      throw new TypeError(`${label}.model must be null or a provider/model string`);
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
        `${label}.thinkingLevel must be null or one of: ${THINKING_LEVELS.join(", ")}`,
      );
    }
  }

  return decoded;
}

function decodeProfiles(
  rawProfiles: unknown,
  label: string,
  warnings: string[],
): Partial<Record<ProfileName, DelegateProfileConfig>> {
  const profiles = objectValue(rawProfiles, label);
  const decoded: Partial<Record<ProfileName, DelegateProfileConfig>> = {};
  for (const [name, rawProfile] of Object.entries(profiles)) {
    if (!PROFILE_NAME_SET.has(name)) {
      warnings.push(`unknown ${label} profile ignored: ${name}`);
      continue;
    }
    decoded[name as ProfileName] = decodeProfile(
      rawProfile,
      `${label}.${name}`,
      warnings,
    );
  }
  return decoded;
}

function decodeModelSetName(value: unknown, label: string): string {
  if (typeof value !== "string" || !MODEL_SET_NAME_PATTERN.test(value)) {
    throw new TypeError(
      `${label} must start with an alphanumeric character and contain only alphanumeric characters, dots, underscores, or hyphens`,
    );
  }
  return value;
}

function decodeTiers(
  value: unknown,
  label: string,
  warnings: string[],
): DelegateTierConfig[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const ids = new Set<string>();
  return value.map((rawTier, index) => {
    const tierLabel = `${label}[${index}]`;
    const tier = objectValue(rawTier, tierLabel);
    for (const field of Object.keys(tier)) {
      if (!TIER_FIELDS.has(field)) {
        warnings.push(`unknown ${tierLabel} field ignored: ${field}`);
      }
    }
    const id = decodeModelSetName(tier.id, `${tierLabel}.id`);
    if (ids.has(id)) throw new TypeError(`${label} contains duplicate tier id: ${id}`);
    ids.add(id);
    if (typeof tier.model !== "string" || !MODEL_PATTERN.test(tier.model)) {
      throw new TypeError(`${tierLabel}.model must be a provider/model string`);
    }
    const decoded: DelegateTierConfig = { id, model: tier.model };
    if (tier.thinkingLevel !== undefined) {
      if (typeof tier.thinkingLevel !== "string" || !THINKING_LEVEL_SET.has(tier.thinkingLevel)) {
        throw new TypeError(`${tierLabel}.thinkingLevel must be one of: ${THINKING_LEVELS.join(", ")}`);
      }
      decoded.thinkingLevel = tier.thinkingLevel as ThinkingLevel;
    }
    if (tier.advisorOnly !== undefined) {
      if (typeof tier.advisorOnly !== "boolean") {
        throw new TypeError(`${tierLabel}.advisorOnly must be a boolean`);
      }
      decoded.advisorOnly = tier.advisorOnly;
    }
    return decoded;
  });
}

function decodeModelSet(
  value: unknown,
  label: string,
  warnings: string[],
): DelegateModelSetConfig {
  const modelSet = objectValue(value, label);
  for (const field of Object.keys(modelSet)) {
    if (!MODEL_SET_FIELDS.has(field)) {
      warnings.push(`unknown ${label} field ignored: ${field}`);
    }
  }
  const decoded: DelegateModelSetConfig = {};
  if (modelSet.tiers !== undefined) {
    decoded.tiers = decodeTiers(modelSet.tiers, `${label}.tiers`, warnings);
  }
  if (modelSet.profiles !== undefined) {
    const profiles = objectValue(modelSet.profiles, `${label}.profiles`);
    decoded.profiles = {};
    for (const [name, profile] of Object.entries(profiles)) {
      if (!PROFILE_NAME_SET.has(name)) {
        warnings.push(`unknown ${label}.profiles profile ignored: ${name}`);
        continue;
      }
      const profileName = name as ProfileName;
      const profileLabel = `${label}.profiles.${name}`;
      if (typeof profile === "string") {
        decoded.profileTiers ??= {};
        decoded.profileTiers[profileName] = decodeModelSetName(profile, profileLabel);
      } else {
        decoded.profiles[profileName] = decodeProfile(profile, profileLabel, warnings);
      }
    }
  }
  return decoded;
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
    config.profiles = decodeProfiles(root.profiles, "profiles", warnings);
  }

  if (root.defaultModelSet !== undefined) {
    config.defaultModelSet = root.defaultModelSet === null
      ? null
      : decodeModelSetName(root.defaultModelSet, "defaultModelSet");
  }

  if (root.modelSets !== undefined) {
    const modelSets = objectValue(root.modelSets, "modelSets");
    config.modelSets = {};
    for (const [name, rawModelSet] of Object.entries(modelSets)) {
      decodeModelSetName(name, `modelSets key ${JSON.stringify(name)}`);
      if (rawModelSet === null) {
        config.modelSets[name] = null;
        continue;
      }

      config.modelSets[name] = decodeModelSet(
        rawModelSet,
        `modelSets.${name}`,
        warnings,
      );
    }
  }

  if (root.parentModelRoutes !== undefined) {
    if (root.parentModelRoutes === null) {
      config.parentModelRoutes = null;
    } else {
      if (!Array.isArray(root.parentModelRoutes)) {
        throw new TypeError("parentModelRoutes must be null or an array");
      }
      config.parentModelRoutes = root.parentModelRoutes.map((rawRoute, index) => {
        const label = `parentModelRoutes[${index}]`;
        const route = objectValue(rawRoute, label);
        for (const field of Object.keys(route)) {
          if (!ROUTE_FIELDS.has(field)) {
            warnings.push(`unknown ${label} field ignored: ${field}`);
          }
        }
        if (!Array.isArray(route.models) || route.models.length === 0) {
          throw new TypeError(`${label}.models must be a non-empty array`);
        }
        const models = route.models.map((pattern, patternIndex) => {
          if (typeof pattern !== "string" || !MODEL_PATTERN.test(pattern)) {
            throw new TypeError(
              `${label}.models[${patternIndex}] must be a provider/model pattern`,
            );
          }
          return pattern;
        });
        return {
          models,
          modelSet: decodeModelSetName(route.modelSet, `${label}.modelSet`),
        };
      });
    }
  }

  return { value: config, warnings };
}

function mergeProfiles(
  target: Partial<Record<ProfileName, DelegateProfileConfig>>,
  source: Partial<Record<ProfileName, DelegateProfileConfig>> | undefined,
): void {
  for (const profileName of PROFILE_NAMES) {
    const profile = source?.[profileName];
    if (!profile) continue;
    const targetProfile = target[profileName] ??= {};
    if (Object.hasOwn(profile, "model")) targetProfile.model = profile.model;
    if (Object.hasOwn(profile, "thinkingLevel")) {
      targetProfile.thinkingLevel = profile.thinkingLevel;
    }
  }
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
    modelSets: {},
    parentModelRoutes: [],
  };

  for (const config of configs) {
    if (!config) continue;
    if (config.defaultProfile) merged.defaultProfile = config.defaultProfile;
    mergeProfiles(merged.profiles, config.profiles);

    if (Object.hasOwn(config, "defaultModelSet")) {
      if (config.defaultModelSet === null) delete merged.defaultModelSet;
      else merged.defaultModelSet = config.defaultModelSet;
    }

    for (const [name, modelSet] of Object.entries(config.modelSets ?? {})) {
      if (modelSet === null) {
        delete merged.modelSets[name];
        continue;
      }
      let target = Object.hasOwn(merged.modelSets, name)
        ? merged.modelSets[name]
        : undefined;
      if (!target) {
        target = {};
        merged.modelSets[name] = target;
      }
      if (modelSet.tiers !== undefined) {
        target.tiers = modelSet.tiers.map((tier) => ({ ...tier }));
      }
      if (modelSet.profiles) {
        target.profiles ??= {};
        for (const profileName of PROFILE_NAMES) {
          if (modelSet.profiles[profileName] !== undefined) {
            delete target.profileTiers?.[profileName];
          }
        }
        mergeProfiles(target.profiles, modelSet.profiles);
      }
      if (modelSet.profileTiers) {
        target.profileTiers ??= {};
        for (const profileName of PROFILE_NAMES) {
          const tierId = modelSet.profileTiers[profileName];
          if (tierId === undefined) continue;
          delete target.profiles?.[profileName];
          target.profileTiers[profileName] = tierId;
        }
      }
    }

    if (Object.hasOwn(config, "parentModelRoutes")) {
      merged.parentModelRoutes = config.parentModelRoutes ?? [];
    }
  }

  if (
    merged.defaultModelSet !== undefined &&
    !Object.hasOwn(merged.modelSets, merged.defaultModelSet)
  ) {
    throw new TypeError(
      `defaultModelSet references unknown model set: ${merged.defaultModelSet}`,
    );
  }
  for (const [index, route] of merged.parentModelRoutes.entries()) {
    if (!Object.hasOwn(merged.modelSets, route.modelSet)) {
      throw new TypeError(
        `parentModelRoutes[${index}] references unknown model set: ${route.modelSet}`,
      );
    }
  }

  for (const [name, modelSet] of Object.entries(merged.modelSets)) {
    for (const profileName of PROFILE_NAMES) {
      const tierId = modelSet.profileTiers?.[profileName];
      if (tierId === undefined) continue;
      const tier = modelSet.tiers?.find((entry) => entry.id === tierId);
      const label = `modelSets.${name}.profiles.${profileName}`;
      if (!tier) throw new TypeError(`${label} references unknown tier: ${tierId}`);
      if (tier.advisorOnly) {
        throw new TypeError(`${label} references advisorOnly tier: ${tierId}`);
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
