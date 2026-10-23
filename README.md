# DSH 模型链 · dsh-model-chain

把多个模型按顺序组成一条降级链，在 DSH 模型选择器中只选择一个模型 ID。当前成员在输出前失败，就尝试下一个；已经输出文字、推理或工具调用后发生错误，则立即停止，避免重复执行工具或混入两个模型的回答。

这是独立社区插件，采用 MIT 许可证。代码由 WorkBuddy 辅助实现，经审查和回归测试后公开。

## 功能

- 设置 → **模型链**：新建、改名、启用或禁用链，从宿主模型目录添加成员并调整顺序。
- 模型选择器 → **模型链**：每条启用且有有效成员的链对应一个模型，格式为 `model-chain / main`。
- 输入框标签显示链名及最近服务成员，例如 `主力链 · deepseek-flash`；菜单内保持只显示链名。
- 配置保存后刷新宿主模型目录；修改只影响后续调用，进行中的请求保留原成员顺序。
- 不保存 API 密钥，不新增外部模型服务；模型请求经 DSH 已配置的 provider 发送。

## 安装

需要 Node.js `^22.19.0 || >=24.0.0`、DSH Web profile，以及至少一个可用 provider。接口已对照 **DSH 0.2.1-rc.2** 的已安装包核对；未声明对其他版本的兼容保证。

克隆后从本地路径安装（Windows、macOS、Linux 均可用）：

```bash
git clone https://github.com/kkaltist/dsh-model-chain.git
cd dsh-model-chain
dsh plugin --profile web add "link:/absolute/path/to/dsh-model-chain"
```

把 `/absolute/path/to/dsh-model-chain` 换成仓库的实际绝对路径。Windows 例如 `link:C:/plugins/dsh-model-chain`。需要 `dsh` 命令可用；通过 npx 使用的安装方式可以将最后一条命令的 `dsh` 换成 `npx @deepseek-ai/dsh@0.2.1-rc.2`。

也可以从 [Releases](https://github.com/kkaltist/dsh-model-chain/releases) 下载 `.tgz` 后安装：

```bash
dsh plugin --profile web add /absolute/path/to/dsh-model-chain-0.1.1.tgz
```

安装后重新加载 DSH Host，再刷新 Web 页面。进入设置 → 模型链，添加成员并保存，最后在模型选择器里选择这条链。通过 `link:` 安装时，插件目录必须保持在原位置。

更新可在仓库中运行 `git pull --ff-only`，再重新加载 DSH 并刷新页面。卸载使用 DSH 插件管理界面；链配置位于下述独立文件中。

## 请求语义

| 情况 | 行为 |
|---|---|
| 成员在输出前返回错误，或直接抛出异常 | 尝试下一成员 |
| 成员只发送了块起始或用量，然后失败 | 丢弃本次元数据，再尝试下一成员 |
| 已输出文字、推理、工具调用或完整内容块后失败 | 终止并报告当前成员错误，不再降级 |
| 用户取消或收到 `aborted` | 立即结束，不调用下一成员 |
| 流在没有 `finish` 的情况下结束 | 作为失败处理；输出后不重试 |
| 全部成员失败 | 报告最后一跳的错误码及 `provider / model` |
| 直接调用已禁用链 | 返回 `CHAIN_DISABLED` |
| 链成员引用 `model-chain` 自己 | 跳过，防止递归；只有自引用成员的链不出现在目录里 |

链不声明统一的上下文容量、推理能力或图片能力；实际行为受每个 provider 的模型与宿主默认值影响。请选择兼容同一任务的成员。插件没有独立超时器：依赖 provider 或调用方发出超时错误或取消信号，持续挂起的请求不会自动换模型。

每次尝试都会将当前请求内容发往对应成员，失败尝试也可能计费；选择成员时应考虑数据去向与费用。

**最近服务成员是当前 Host 进程内、按链聚合的观测记录**，以 6 秒间隔轮询，并非当前会话或当前请求的精确归属。多个会话同时使用同一条链时会共享该记录；重启后清空。菜单和选项行不会发起轮询。

## 存储

默认路径为 `~/.dsh/model-chain/state.json`，也可以通过 `DSH_HOME` 改变根目录。仓库和发布包不包含用户配置。

```json
{
  "chains": [
    {
      "id": "main",
      "name": "主力链",
      "enabled": true,
      "members": [
        { "provider": "provider-a", "model": "model-a" },
        { "provider": "provider-b", "model": "model-b" }
      ]
    }
  ]
}
```

改名保持 ID 不变。保存按当前进程内的到达顺序串行执行，通过唯一临时文件原子替换；多个 Host 进程共享同一个 `DSH_HOME` 时仍是最后写入者覆盖，不提供跨进程锁。

JSON 损坏或根结构无效时，先备份为 `state.json.broken-<时间戳>-<随机标识>`，然后使用默认空链。读取权限等 I/O 错误、备份失败会明确报错，不会静默重置配置。

## 本地设置接口

| 方法 | 路径 | 返回或用途 |
|---|---|---|
| GET | `/api/model-chain/state` | `{ route, chains, catalog }`，链包含最近服务信息 |
| POST | `/api/model-chain/state` | 用 `{ chains }` 整体保存 |
| GET | `/api/model-chain/catalog` | `{ groups }`，当前 provider 模型目录 |
| GET | `/api/model-chain/last` | `{ route, last }`，最近服务记录 |

这些原始 HTTP 路由不经过 DSH Remote gateway，因此只接受 **loopback 客户端、loopback Host 和同源浏览器请求**。POST 必须使用 `application/json`，请求体不超过 2,000,000 字节。**远程访问、反向代理域名和局域网设置页面不在支持范围内**；需要这些部署方式时，应先接入宿主的完整鉴权机制。

## 开发与验证

无构建步骤；测试只依赖 Node.js 内置模块，不需要下载依赖或真实模型密钥。

```bash
npm run check
npm test
npm pack --dry-run
```

`npm test` 包含 7 组核心自测、3 组模型标签自测、14 项回归测试。回归覆盖异常降级、元数据隔离、输出后失败、取消、禁用链、初始化等待、迭代器清理、并发落盘、损坏配置备份，以及真实本地 HTTP 服务的参数、大小和同源边界。

GitHub Actions 在 Node.js 22/24、Windows/Linux 上运行检查；推送 `v<package.json 版本>` 标签会在检查通过后生成 GitHub Release 和 `.tgz` 附件，不发布到 npm 注册表。

本次验证未新增真实付费模型请求，也没有重启正在使用的 DSH。详见 [审查记录](docs/REVIEW.md) 和 [变更记录](CHANGELOG.md)。

如需复现与已安装 DSH 的隔离集成验证，可额外执行（用真实安装路径替换参数）：

```bash
node scripts/host-smoke.mjs /absolute/path/to/node_modules/@deepseek-ai/dsh/package.json
```

这会加载真实 Cordis/LLM/BlockAssembler，注册两个假 provider，验证失败降级与内容组装，不会发出真实模型网络请求。
