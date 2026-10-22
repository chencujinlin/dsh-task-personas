# 配套 IM Connect 人格扩展版

本目录是 **dsh-task-personas 0.7.0 配套使用的 IM 插件**。

- 包名：`@michengai/dsh-im-connect`
- 扩展版本：`1.0.8-personas.6`
- 上游基础：[MichengAI/dsh-im-connect](https://github.com/MichengAI/dsh-im-connect) `1.0.8`
- 宿主已验证版本：DSH 桌面端 `0.2.1-rc.2`
- 安装包：同仓库 [v0.7.0 Release](https://github.com/chencujinlin/dsh-task-personas/releases/tag/v0.7.0) 的 `michengai-dsh-im-connect-1.0.8-personas.6.tgz`

必须与主插件一起安装。普通上游版不提供本项目所需的 `taskPersonaMedia` 传输注册、后台原生会话唤醒、未 @ 群消息观察、其他机器人身份过滤和新版卡片正文读取。

扩展保留上游包名，会替换同名包；不要同时运行两份。飞书账号、密钥、会话映射仍使用用户自己的运行配置，不随仓库发布。完整安装步骤见 [根目录 README](../README.md)。

主插件负责人格和聊天策略，本扩展负责 IM 连接：所有飞书普通回复使用原生文字气泡，按钮审批保留交互卡片；取消自动 OnIt/DONE/ERROR 状态回应；原有其他渠道行为保留。扩展关闭上游更新器，避免被普通上游包覆盖。

源码在 `src/`，安装使用预构建 `lib/`。修改 TypeScript 后应同步生成对应 JavaScript。行为改动见 [LOCAL_CHANGES.md](LOCAL_CHANGES.md)。上游一般连接配置可参考 [官方仓库文档](https://github.com/MichengAI/dsh-im-connect/blob/main/README.zh-CN.md)，本扩展的兼容关系以此仓库根文档为准。

本目录及其修改遵循 [Apache-2.0](LICENSE)，不是上游官方发布版本。
