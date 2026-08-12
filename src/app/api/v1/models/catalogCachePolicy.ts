export type RefreshTask = () => Promise<void>;

export type CatalogCachePolicy = {
  getStaleWhileRevalidateMs?: () => number;
  scheduleBackgroundRefresh?: (task: RefreshTask) => void;
};

export type CatalogSettings = { hideAutoCombos?: boolean; hideNoThinkVariants?: boolean };

export type InFlightBuild<T> = {
  generation: number;
  promise: Promise<T>;
};

function isCatalogCachePolicy(value: unknown): value is CatalogCachePolicy {
  return (
    !!value &&
    typeof value === "object" &&
    ("getStaleWhileRevalidateMs" in value || "scheduleBackgroundRefresh" in value)
  );
}

export function normalizeCatalogCacheArgs(
  catalogSettingsOrPolicy?: CatalogSettings | CatalogCachePolicy,
  policyOrSettings?: CatalogCachePolicy | CatalogSettings
): { catalogSettings?: CatalogSettings; policy: CatalogCachePolicy } {
  if (isCatalogCachePolicy(catalogSettingsOrPolicy)) {
    return {
      catalogSettings: isCatalogCachePolicy(policyOrSettings)
        ? undefined
        : (policyOrSettings as CatalogSettings | undefined),
      policy: catalogSettingsOrPolicy,
    };
  }
  return {
    catalogSettings: catalogSettingsOrPolicy,
    policy: isCatalogCachePolicy(policyOrSettings) ? policyOrSettings : {},
  };
}

export function startCatalogBackgroundRefresh<T>(opts: {
  cacheKey: string;
  generation: number;
  inFlight: Map<string, InFlightBuild<T>>;
  isCurrentGeneration: (generation: number) => boolean;
  runRefresh: () => Promise<T>;
  policy: CatalogCachePolicy;
  defaultScheduler: (task: RefreshTask) => void;
}): Promise<T> {
  if (opts.inFlight.has(opts.cacheKey)) {
    return opts.inFlight.get(opts.cacheKey)!.promise;
  }

  let refreshTask!: RefreshTask;
  let rejectRefresh!: (reason?: unknown) => void;
  const refreshPromise: Promise<T> = new Promise((resolve, reject) => {
    rejectRefresh = reject;
    refreshTask = async () => {
      if (opts.inFlight.get(opts.cacheKey)?.promise !== refreshPromise) return;
      if (!opts.isCurrentGeneration(opts.generation)) return;
      await opts.runRefresh().then(resolve, reject);
    };
  });

  refreshPromise.catch(() => {});
  opts.inFlight.set(opts.cacheKey, { generation: opts.generation, promise: refreshPromise });

  try {
    (opts.policy.scheduleBackgroundRefresh ?? opts.defaultScheduler)(refreshTask);
  } catch (error) {
    opts.inFlight.delete(opts.cacheKey);
    queueMicrotask(() => rejectRefresh(error));
  }

  refreshPromise
    .finally(() => {
      if (opts.inFlight.get(opts.cacheKey)?.promise === refreshPromise) {
        opts.inFlight.delete(opts.cacheKey);
      }
    })
    .catch(() => {});
  return refreshPromise;
}
