import { homedir } from "node:os";
import path from "node:path";

export const PACKAGE_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

export function resolveBridgePaths(env = process.env) {
  const home = path.resolve(env.HOME || homedir());
  const dataRoot = path.resolve(env.CODEX_TELEGRAM_BRIDGE_HOME || path.join(home, ".codex-telegram-bridge"));
  const configHome = env.XDG_CONFIG_HOME ? path.resolve(env.XDG_CONFIG_HOME) : path.join(home, ".config");
  const cacheHome = env.XDG_CACHE_HOME ? path.resolve(env.XDG_CACHE_HOME) : path.join(home, ".cache");
  return {
    home,
    packageRoot: PACKAGE_ROOT,
    dataRoot,
    projectsRoot: path.join(dataRoot, "projects"),
    stateRoot: path.join(dataRoot, "state"),
    logsRoot: path.join(dataRoot, "logs"),
    cacheRoot: path.join(dataRoot, "cache"),
    configFile: path.resolve(env.CODEX_TELEGRAM_BRIDGE_CONFIG || path.join(dataRoot, "config.env")),
    systemdDir: path.join(configHome, "systemd", "user"),
    systemdUnit: path.join(configHome, "systemd", "user", "codex-telegram-bridge.service"),
    telegramMediaRoot: path.resolve(env.TELEGRAM_MEDIA_CACHE_ROOT || path.join(cacheHome, "codex-telegram-bridge", "telegram-media")),
  };
}
