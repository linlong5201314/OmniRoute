import { join } from "node:path";
import { resolveDataDir } from "@/lib/dataPaths";

/**
 * Writable cache directory for tls-client-node's native binary.
 *
 * Without an explicit `downloadDir`, the library defaults to its own package
 * `node_modules/tls-client-node/bin`, which is root-owned on global installs
 * and fails with EACCES for normal users (#8579).
 */
export function resolveTlsClientDownloadDir(): string {
  return join(resolveDataDir(), "tls-client", "bin");
}

export function buildNativeTlsClientOptions():
  | {
      runtimeMode: "native";
      nativeLibraryPath: string;
    }
  | {
      runtimeMode: "native";
      downloadDir: string;
    } {
  const nativeLibraryPath = process.env.OMNIROUTE_TLS_CLIENT_NATIVE_LIBRARY_PATH?.trim();
  if (nativeLibraryPath) {
    return {
      runtimeMode: "native",
      nativeLibraryPath,
    };
  }

  return {
    runtimeMode: "native",
    downloadDir: resolveTlsClientDownloadDir(),
  };
}
