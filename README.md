# dsh-stream-tuning

让 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) Web UI 在高延迟网络下也能流畅出字。

DSH 把模型的每个 token 片段单独作为一帧，通过 `/api/remote.mux` WebSocket 发给浏览器，而且这条连接不压缩。本机访问时感觉不到问题；经公网、反向代理访问时，一条回答会变成上千个小 JSON 帧，浏览器需要逐个接收、解析和渲染。

本插件做两件事，不修改 DSH 或其他插件的任何文件。正常完成时，最终正文、思考内容、工具名称与参数保持一致；但原始流的 chunk 数量、分片和时间记录会变化，落盘的流记录并非逐字节不变。

## 1. 合并流式增量

插件挂在 DSH 公开的 `llm/stream` 钩子上，把同一个 block 的连续 `text-delta` / `reasoning-delta` / `tool-call-delta` 合并，默认每 50ms 发一块：

- 静默一段时间后的第一个增量立即放行，首字时间不变
- `block-start`、`block-end`、`usage`、`finish` 原样按序透传，透传前先把待发的增量发完
- 下游（流格式校验、agent loop、帧 revision/index）看到的仍是合法且连续的流，只是 chunk 更少
- 上游中间件直接抛异常时，先发出已经收到的待发增量，再把原异常传给下游；不会把错误伪装成成功
- 消费者提前结束时，立即请求关闭上游；若预取的 `next()` 尚未完成，不等待它再返回。异步清理失败会记录警告，已停止消费的预取结果不再发出

取消网络请求仍依赖调用方的 AbortSignal（DSH 原生任务取消会传递该信号）。迭代器的 `return()` 不是网络取消：上游若不响应取消且一直不返回，资源清理仍需等待读取结束；插件不再因此阻塞消费者的返回。

## 2. mux 连接开启 permessage-deflate

网关的 mux `WebSocketServer` 是私有实例，创建时没有开启压缩。`ws` 在每次握手时才读取 `perMessageDeflate`，所以插件在 `/api/remote.mux` 握手前给这个实例开启压缩，浏览器协商成功即生效。其他 WebSocket 服务不受影响。如果 DSH 或 `ws` 的结构有变，插件只记一条警告并跳过压缩，不影响启动。

默认保留上下文接管（context takeover），复用压缩字典，提高连续 JSON 消息的压缩率。虽然默认配置包含 `threshold: 128`，但当前 `ws` 只有在协商关闭**服务端**上下文接管时才应用这个发送阈值；默认情况下小消息也会压缩。只有确实需要“低于 128 字节不压缩”时，才同时配置 `serverNoContextTakeover: true`；这会改变压缩率与资源使用，不是本次修复的默认行为。

## 实测（DSH 0.2.0-rc.2，同一提示词，约 600 字中文回答）

| | mux 帧数 | 线路字节 |
|---|---|---|
| 未安装 | 约 530–1100 | 210–390 KB（不压缩） |
| 安装后 | 约 140–170 | 约 21 KB（压缩后，估算） |

## 安装

```sh
dsh plugin --profile web add file:/path/to/dsh-stream-tuning
```

安装后重启 DSH。

## 配置

```yaml
- id: stream-tuning
  config:
    coalesceMs: 50        # 合并窗口；0 关闭合并
    compression: true     # false 关闭 mux 压缩
    deflate:              # 额外的 ws PerMessageDeflate 选项
      threshold: 128      # 仅在协商关闭服务端上下文接管时生效
      # serverNoContextTakeover: true  # 按需启用，不是默认值
```

## 卸载

```sh
dsh plugin --profile web remove dsh-stream-tuning
```

然后重启 DSH。

## License

MIT
