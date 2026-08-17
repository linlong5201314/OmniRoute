/**
 * Pinned mihomo (MetaCubeX) release assets for the embedded proxy core.
 *
 * The embedded proxy core downloads a mihomo binary at runtime (cached under
 * DATA_DIR so Railway's persistent volume reuses it across deploys) and runs it
 * to translate SS/VMess/VLESS/Trojan/… subscription nodes into a local
 * SOCKS5/HTTP endpoint. Every asset is pinned to an exact version + SHA-256
 * digest (verified after download) so a compromised mirror or MITM cannot swap
 * the binary — the same supply-chain posture the repo applies to tls-client.
 *
 * Pure module — no I/O — so asset selection is unit-testable.
 */

export const MIHOMO_VERSION = "v1.19.30";

/** Official GitHub release base URL for the pinned version. */
export const MIHOMO_RELEASE_BASE = `https://github.com/MetaCubeX/mihomo/releases/download/${MIHOMO_VERSION}`;

export interface MihomoAsset {
  /** Release asset file name (as published on GitHub). */
  fileName: string;
  /** Official SHA-256 digest of the asset (hex, lowercase). */
  sha256: string;
  /** Archive format the asset is distributed in. */
  archive: "gz" | "zip";
}

/**
 * Supported platform/arch → release asset. Keys are `${platform}-${arch}` using
 * Node's `process.platform` / `process.arch` values.
 *
 * - linux-amd64 uses the `-compatible` build (broadest x86-64 microarch level,
 *   safest for shared PaaS runners whose CPU flags are unknown).
 * - Windows is intentionally absent: the embedded core targets container/VPS
 *   deployments; on a Windows desktop the operator already runs their own core.
 */
export const MIHOMO_ASSETS: Record<string, MihomoAsset> = {
  "linux-x64": {
    fileName: `mihomo-linux-amd64-compatible-${MIHOMO_VERSION}.gz`,
    sha256: "db214c7a2517e63c150d123178d16d102e03a241ccdae4e5e07ffbe9cf56c6f9",
    archive: "gz",
  },
  "linux-arm64": {
    fileName: `mihomo-linux-arm64-${MIHOMO_VERSION}.gz`,
    sha256: "58896873736d28628f66de3677c8654fa0f180662523148e136cff4f6e890069",
    archive: "gz",
  },
  "darwin-x64": {
    fileName: `mihomo-darwin-amd64-${MIHOMO_VERSION}.gz`,
    sha256: "99dfcfe454ed58fb95ee4ba222c39defd051b687ad3e5deabb1b9d6be3103e2f",
    archive: "gz",
  },
  "darwin-arm64": {
    fileName: `mihomo-darwin-arm64-${MIHOMO_VERSION}.gz`,
    sha256: "2c7f3a7904fa1cee291e124123e630e7b1ebd13765dd9bf26c0a28432004d9f4",
    archive: "gz",
  },
};

/**
 * Resolve the release asset for a platform/arch pair. Returns null when the
 * combination is unsupported (e.g. win32, linux-ia32) — callers must treat that
 * as "embedded core unavailable", not an error to retry.
 */
export function resolveMihomoAsset(platform: string, arch: string): MihomoAsset | null {
  return MIHOMO_ASSETS[`${platform}-${arch}`] ?? null;
}

/** Full download URL for an asset. */
export function mihomoAssetUrl(asset: MihomoAsset): string {
  return `${MIHOMO_RELEASE_BASE}/${asset.fileName}`;
}
