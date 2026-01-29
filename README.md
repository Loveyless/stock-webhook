# stock-webhook

原生 Node.js HTTP webhook 服务（见 `stockhook.js`）。

## 运行

必填环境变量：

- `STOCKHOOK_TOKEN`：鉴权 token（POST `/webhook`/`/hook` 必须提供）

可选环境变量：

- `STOCKHOOK_HOST`：默认 `0.0.0.0`
- `STOCKHOOK_PORT`：默认 `49554`
- `STOCKHOOK_DATA_DIR`：默认 `/root/stockhook/data`
- `STOCKHOOK_MAX_BODY`：默认 `262144`（256KiB）
- `STOCKHOOK_PREVIEW_BYTES`：默认 `262144`（256KiB）
- `STOCKHOOK_RENDER_MAX_BYTES`：默认 `2097152`（2MiB）
- `STOCKHOOK_MAX_RECORDS`：默认 `15`
- `STOCKHOOK_READ_TOKEN_REQUIRED`：设为 `1/true` 时，GET `/`、`/view`、`/raw` 也要求 token

启动：

```bash
npm run start
```

接口：

- `POST /webhook` 或 `POST /hook`：写入一条记录
- `GET /`：列表页
- `GET /view?id=<record.json>`：查看
- `GET /raw?id=<record.json>`：下载原文
- `GET /health`：健康检查

