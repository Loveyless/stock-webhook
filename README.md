# stock-webhook

原生 Node.js HTTP webhook 服务（见 `stockhook.js`）。

## 代码结构

- `stockhook.js`：CLI 入口（保留向后兼容导出 `createServer`）
- `server.js`：HTTP 路由与 handler（核心逻辑入口）
- `config.js`：环境变量与默认值
- `auth.js`：token 鉴权 + CORS
- `store.js`：落盘/预览截断/保留策略
- `render/*`：页面/Markdown 渲染与标题提取

## 运行

必填环境变量：

- `STOCKHOOK_TOKEN`：鉴权 token（POST `/webhook`/`/hook` 必须提供）

可选环境变量：

- `STOCKHOOK_HOST`：默认 `0.0.0.0`
- `STOCKHOOK_PORT`：默认 `49554`
- `STOCKHOOK_DATA_DIR`：数据目录；默认 `<脚本目录>/data`
- `STOCKHOOK_MAX_BODY`：默认 `10485760`（10MiB）
- `STOCKHOOK_PREVIEW_BYTES`：默认 `512000`（500KiB）
- `STOCKHOOK_RENDER_MAX_BYTES`：默认 `10485760`（10MiB）
- `STOCKHOOK_MAX_RECORDS`：默认 `100`
- `STOCKHOOK_READ_TOKEN_REQUIRED`：设为 `1/true` 时，GET `/`、`/view`、`/raw` 也要求 token

启动：

```bash
npm run start
```

开发启动（默认 `STOCKHOOK_TOKEN=123`，数据目录默认 `./data`，并默认仅监听 `127.0.0.1`）：

```bash
npm run start:dev
```

## 打包（单文件 JS）

构建输出：`dist/stockhook.js`（包含 mock 页面，无需再拷贝 `render/*`、`mock.html`）。

```bash
npm i
npm run build
node dist/stockhook.js
```

接口：

- `POST /webhook` 或 `POST /hook`：写入一条记录
- `GET /`：列表页
- `GET /mock`：mock 发送页（输入 URL+JSON，一键 POST）
- `GET /view?id=<record.json>`：查看
- `GET /raw?id=<record.json>`：下载原文
- `GET /health`：健康检查

