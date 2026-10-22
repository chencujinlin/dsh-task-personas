# DSH 会话人格 · 飞书聊天扩展

为 DeepSeek Harness 的飞书会话添加「小鲸鱼 / 傲娇助手」、表情库、主动聊天和自主参与群聊。每个会话单独设置，普通任务、新会话默认关闭。

> **完整功能必须配合本仓库的 IM Connect 人格扩展版使用。**
> 配套包名：`@michengai/dsh-im-connect`，版本：**`1.0.8-personas.6`**，源码位于 [im-connect/](im-connect/)。它基于 [MichengAI/dsh-im-connect](https://github.com/MichengAI/dsh-im-connect) **1.0.8** 修改。普通上游 1.0.8 没有本项目所需的表情传输、后台唤醒和群消息观察接口。

## 兼容版本

| 组件 | 已验证版本 | 用途 |
| --- | --- | --- |
| DeepSeek Harness 桌面端 | `0.2.1-rc.2` | 宿主、模型、权限与原生插件管理 |
| dsh-task-personas | `0.7.0` | 本仓库根目录；人格、表情库、聊天节奏与群消息判断 |
| IM Connect 人格扩展版 | `@michengai/dsh-im-connect@1.0.8-personas.6` | 本仓库 `im-connect/`；飞书接收与原生消息发送 |

配套桥接保留上游包名，因此它会**替换同名 IM Connect 包**，不要并行启动两份桥接。其他宿主版本尚未验证。人格提示词不替换宿主预设，也不改变会话模型或人工审批策略。

## 安装

### 桌面界面

在 [v0.7.0 Release](https://github.com/chencujinlin/dsh-task-personas/releases/tag/v0.7.0) 下载这两个文件：

1. `michengai-dsh-im-connect-1.0.8-personas.6.tgz`：配套 IM 插件。
2. `dsh-task-personas-0.7.0.tgz`：人格插件。

在 DSH 的「插件 → 添加插件」中依次安装两个本地安装包并启用，然后重启 DSH。已有 IM Connect 用户使用第一个包替换上游包；如界面提示同名包已安装，先通过原生插件管理器移除旧包，再安装扩展版。飞书应用凭据只在你自己的 DSH 配置界面填写。

也可直接使用 Release 下载地址：

```text
https://github.com/chencujinlin/dsh-task-personas/releases/download/v0.7.0/michengai-dsh-im-connect-1.0.8-personas.6.tgz
https://github.com/chencujinlin/dsh-task-personas/releases/download/v0.7.0/dsh-task-personas-0.7.0.tgz
```

### macOS 桌面端 CLI

先完全退出 DSH，再使用桌面端自带的 CLI：

```sh
dsh_bin='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
"$dsh_bin" plugin --profile desktop add --ignore-scripts \
  'https://github.com/chencujinlin/dsh-task-personas/releases/download/v0.7.0/michengai-dsh-im-connect-1.0.8-personas.6.tgz' \
  'https://github.com/chencujinlin/dsh-task-personas/releases/download/v0.7.0/dsh-task-personas-0.7.0.tgz'
```

Desktop 的 profile 与普通全局/Web CLI 独立。安装后打开桌面应用，在插件页确认两项均已启用。发布包包含预构建 JavaScript，无需修改应用包或编译宿主；`--ignore-scripts` 跳过依赖安装脚本，本项目不需要执行这些脚本。若界面安装遇到 `Ignored build scripts: protobufjs`，使用上述命令，无需放宽全局脚本审批设置。Release 提供 `SHA256SUMS.txt`。

## 使用

1. 在 IM Connect 中配置飞书账号并建立会话。
2. 打开 DSH「频道」中的目标会话，在输入栏的人格菜单选择「小鲸鱼」或「傲娇助手」。
3. 想让机器人参与群聊时，为该群打开「自主参与群聊」。
4. 在「群机器人」里查看其他机器人的 ID，选择可互聊的对象；在「表情库」里导入或收藏表情。

人格切换从下一次模型请求生效，聊天记录保留。桥接 `/new` 或重置生成的新会话不继承旧人格；子智能体也不继承。

### 群消息全部阅读，模型决定是否回复

- 已开启自主参与的群：收到的真人消息与已选机器人消息都会进入模型判断，**没有 5% 抽样、每分钟一次或每小时 12 次的群消息唤醒限制**。
- 连续消息先合并约 8 秒，再分批交给模型；每批最多 40 条未读消息。会话忙时排队，超过两分钟也不会丢弃实时未读消息。
- 未读队列与最近 12 条已读背景分开；消息进入宿主模型输入事件后才确认已读。模型可以调用 `feishu_social_skip`，安静结束。
- **台北时间 22:00–次日 08:00 不回应其他机器人，真人消息照常。**夜间不补发机器人旧消息；机器人草稿发送前会再检查时段。
- @ 当前机器人的请求沿用原有工作流程。普通旁观消息只允许聊天工具，不据此执行本地命令或账号操作。

旁观文字每条最多 500 字；未 @ 的图片、表情和文件提供占位，不自动下载或声称已看图。实时观察和未读队列暂存在内存，退出应用后不自动补发。可手动用「补读接入后群消息」读取该会话首次接入后的可见历史：最多查询 200 条，最近 40 条作为背景；模型不会逐条补答旧消息。

### 表情与主动聊天

- 导入 PNG / JPG / WEBP / GIF，填写名称、适用场景并收藏；也可收藏当前飞书会话收到的图片或原生表情。发布仓库**不附带任何个人表情收藏**。
- 模型通过 `feishu_send_message` / `feishu_send_sticker` 发言，普通内部叙述不会自动转发到飞书。飞书普通回复为原生文字气泡，审批按钮仍使用交互卡片。
- 人格菜单的「主动聊天」控制冷场开聊：30～90 分钟检查、安静至少 15 分钟、基础概率 30%。这套冷场节奏与实时群消息全量阅读独立。
- 图片和文字保留发送频率保护，未确认的发送不自动重试。发送目标由当前会话绑定决定，模型不能任意指定收件人。

## 飞书权限

在飞书应用后台配置相应权限及 `im.message.receive_v1` 事件订阅，发布应用版本使变更生效：

| 场景 | 所需能力 |
| --- | --- |
| 基础私聊、回复、图片 | 消息接收/发送及图片上传权限 |
| 无需 @ 读取群消息 | 获取群组中所有消息，如 `im:message.group_msg` |
| 接收其他机器人群消息 | `im:message.group_msg.include_bot:read` |
| 手动补读历史、读取新版卡片正文 | 群消息和消息读取权限 |

权限名称可能随平台变化，以 [飞书接收消息文档](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive) 和 [历史消息文档](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/list) 为准。仅有 @ 权限时，本地开关不能让平台推送未 @ 消息。

## 数据与隐私

插件默认在 `DSH_HOME`（未设置时为 `~/.dsh`）下保存：

- `task-personas/sessions.json`：人格选择。
- `task-personas/social.json`：聊天设置、已选机器人和时间状态。
- `task-personas/stickers/`：个人表情素材及元数据。
- IM Connect 自己的会话映射、凭据与日志继续由桥接管理。

这些运行数据不属于源码，也不应提交到 GitHub。聊天内容会交给你在 DSH 中选择的模型服务处理；发送消息仍调用飞书接口。项目没有额外的聊天收集服务，公开发布包不包含开发者的聊天、账号、群 ID、凭据、截图或本机安装状态。管理接口沿用 DSH 登录认证与跨站校验。

## 开发与验证

Node.js 22 或更高版本：

```sh
npm ci
npm run check
npm run check:bridge
npm test
npm run test:privacy
```

测试使用合成数据和模拟飞书 SDK，不发送真实消息。宿主集成测试使用根目录锁定的 DSH SDK 开发依赖；可用 `DSH_SDK_ROOT` 指定另一套 SDK 根目录。当前覆盖 59 项行为测试，包含全量读取、106 条消息分批、忙时保留、@ 抢占、夜间规则、鉴权和原子写入失败。

主插件运行代码位于 `lib/`。桥接的 TypeScript 源码与预构建产物位于 `im-connect/src/` 和 `im-connect/lib/`。仓库不包含本机验证日志、截图或私有测试配置。发布前运行 [公开文件检查](scripts/check-public.mjs)，并独立执行密钥扫描。

## 来源与许可

- 主插件：MIT，见 [LICENSE](LICENSE)。
- 人格卡来自 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)，固定提交及校验值见 `roles/source.json`。原文保存在 `roles/upstream/`，活动卡片为飞书适配版；见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
- 配套 IM 插件基于 [MichengAI/dsh-im-connect](https://github.com/MichengAI/dsh-im-connect) 1.0.8，遵循 Apache-2.0；见 [配套说明](im-connect/UPSTREAM_NOTICE.md) 及 [本地扩展记录](im-connect/LOCAL_CHANGES.md)。

本项目未移植 QQ 拍一拍、QQ 收藏同步或群友黑话后台学习。它是独立社区扩展，不是 DSH、飞书或上游 IM Connect 的官方发行版。
