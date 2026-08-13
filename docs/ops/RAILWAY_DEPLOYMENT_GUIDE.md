---
title: "Railway Deployment Guide"
version: 3.8.50
lastUpdated: 2026-08-13
---

# Railway 部署指南

OmniRoute 可以直接使用仓库根目录的 `Dockerfile` 部署到 Railway。服务按单端口运行：Railway 注入的 `PORT` 会同时承载 Dashboard 和 `/v1/*` API。

## 1. 创建服务

1. 在 Railway 中选择 **Deploy from GitHub Repo**，选择 OmniRoute 仓库。
2. Railway 会读取根目录的 `railway.json`，使用 `Dockerfile` 构建。
3. 在 **Settings → Networking** 生成 Public Domain。
4. 在 **Volumes** 添加一个持久卷，挂载路径必须是 `/app/data`。

不要在 Railway 上覆盖启动命令。Dockerfile 已经使用 standalone 启动器，并会自动转发 Railway 提供的 `PORT`。

## 2. 必需环境变量

在 Railway 服务的 **Variables** 中设置下面这些变量。每个值都应是你自己生成的唯一值：

```dotenv
NODE_ENV=production
DATA_DIR=/app/data
RAILWAY_RUN_UID=0
INITIAL_PASSWORD=<首个管理员密码>
JWT_SECRET=<openssl rand -base64 48>
API_KEY_SECRET=<openssl rand -hex 32>
OMNIROUTE_WS_BRIDGE_SECRET=<openssl rand -base64 32>
AUTH_COOKIE_SECURE=true
REQUIRE_API_KEY=true
OMNIROUTE_ENABLE_LIVE_WS=0
```

`NODE_ENV=production`、`DATA_DIR=/app/data` 和 `INITIAL_PASSWORD` 是必需项。`JWT_SECRET`、`API_KEY_SECRET` 和 `OMNIROUTE_WS_BRIDGE_SECRET` 也应当设置成你自己生成的唯一值。`AUTH_COOKIE_SECURE=true` 让登录 Cookie 只通过 HTTPS 发送；`REQUIRE_API_KEY=true` 防止公网 `/v1/*` 端点被匿名调用；`OMNIROUTE_ENABLE_LIVE_WS=0` 关闭 Railway 单端口部署无法单独暴露的实时监控端口。

`PORT` 不要手动固定，保留 Railway 自动注入的值。`API_PORT`、`DASHBOARD_PORT`、`LIVE_WS_PORT` 也不要设置，Railway 单服务只需要暴露一个端口。

`OMNIROUTE_TLS_CLIENT_NATIVE_LIBRARY_PATH` 也不要手动设置。Docker 镜像已将经过 SHA-256 校验的原生库放在 `/app/native` 并自动配置该变量；覆盖它可能让 web provider 在启动后加载错误的库路径。

`RAILWAY_RUN_UID=0` 建议直接设置。该镜像默认以非 root 用户运行，而 Railway 官方说明非 root 镜像挂载卷时可能遇到权限问题；设置为 `0` 可避免 `/app/data` 无法写入。不要在没有持久卷的部署中依赖容器文件系统保存数据。

生成 Railway 公网域名后，如果要使用 OAuth 回调或需要固定的公开链接，再设置：

```dotenv
NEXT_PUBLIC_BASE_URL=https://<你的 Railway 域名>
```

普通 API 代理和 Dashboard 登录不依赖这个变量。`BASE_URL` 保持未设置，让容器内部任务使用默认回环地址；不要把它改成公网域名。

## 3. 可选的加密与缓存

如果要对 SQLite 中保存的 API key、token 等敏感字段启用 AES-256-GCM 加密，再增加：

```dotenv
STORAGE_ENCRYPTION_KEY=<openssl rand -hex 32>
STORAGE_ENCRYPTION_KEY_VERSION=v1
```

启用后必须长期保存密钥；丢失或更换密钥会导致已加密的凭据无法解密。该变量是字段级加密，不是 SQLCipher 整库加密。

Redis 不是启动必需项。没有 `REDIS_URL` 时，限流使用当前实例内存。

单实例、低流量部署可以先不配 Redis。需要在应用重启后保留限流计数，或希望限流状态与进程内存解耦时，再创建 Railway Redis，并设置：

```dotenv
REDIS_URL=${{Redis.REDIS_URL}}
```

不要把 `redis://localhost:6379` 填到 Railway；那只会连接应用容器自身，不是 Railway Redis 服务。

## 4. SQLite、持久卷和副本限制

- SQLite 是 OmniRoute 的主数据库，保存管理员、API keys、provider connections、combos、日志和运行状态。
- Railway **必须配置持久卷** 才能保留这些数据。没有持久卷时，重新部署或实例迁移会回到空数据库。
- 服务副本数必须保持为 **1**。`railway.json` 已经固定 `numReplicas: 1`，而且 SQLite 也不能由多个实例同时写入同一个文件。

## 5. 首次启动

1. 等待部署通过 `/api/health/live` 健康检查。`railway.json` 里的 `healthcheckPath` 也是这个路径。这个路径只验证 HTTP 服务已启动；`/api/health/ping` 仍用于验证 SQLite 是否可查询。
2. 打开 `https://<你的域名>/dashboard`。
3. 使用 `INITIAL_PASSWORD` 登录，随后在 Dashboard 的 Security 设置中修改密码。
4. 在 Provider Connections 中添加自己的 provider keys 或 OAuth 连接。
5. API 基础地址是 `https://<你的域名>/v1`。

示例：

```bash
curl https://<你的域名>/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <Dashboard 中创建的 API key>" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}]}'
```

## 6. Railway 注意事项

- Docker 构建会编译 `better-sqlite3`，构建需要 Railway 的标准 Docker builder 网络访问 npm 和 GitHub Releases。
- 根 `Dockerfile` 的默认最终阶段是 `runner-cli`，因此直接从仓库部署会包含 Codex/Claude/OpenClaw 等 CLI 工具，镜像会比基础镜像大，但不影响 Dashboard 和 API 运行。项目现有 Compose/CI 流程仍可显式选择 `runner-base`。
- web-cookie provider（例如 `gemini-web`、`claude-web`）需要带 Chromium 的 `runner-web` 镜像；Railway 直接使用根 Dockerfile 时不会自动选择该阶段，这类 provider 需要先构建并发布 `runner-web` 镜像。
- Railway 只暴露一个公共端口，因此不要启用 split-port 或单独暴露 live WebSocket 端口。主变量清单已关闭 Dashboard 的独立实时监控端口。
