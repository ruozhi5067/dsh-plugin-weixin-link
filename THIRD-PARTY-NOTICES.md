# 第三方组件与协议来源

本仓库的 MIT 许可（见 [LICENSE](LICENSE)）适用于本仓库作者编写的代码。
下列第三方内容按其自身许可使用 / 引用：

## 1. qrcode-generator 1.4.4

- 文件：`vendor/qrcode.js`
- 许可：MIT License
- 版权：Copyright (c) 2009 Kazuhiko Arase
- 用途：内置二维码生成库，用于生成微信登录二维码（随包内联，不依赖网络 CDN）。

## 2. WeChat iLink Bot 协议

- 参考项目：[`Tencent/openclaw-weixin`](https://github.com/Tencent/openclaw-weixin)（v2.4.10，MIT）
- 用途：本插件的微信 iLink Bot 协议实现（扫码登录、长轮询、发消息、媒体加解密等）依据该官方开源项目的
  `docs/protocol_zh_CN.md` 与 `src/**` 源码逐条对齐，整理稿见
  [`docs/wechat-ilink-protocol.md`](docs/wechat-ilink-protocol.md)。
- 本插件**不包含**该项目的源代码；仅独立实现同一协议以与微信 ClawBot 通信。

## 3. 微信「龙虾」ClawBot

- 微信官方提供的 ClawBot 能力属于腾讯；本插件只作为客户端接入，不包含其实现。
- 使用本插件需要在手机微信中安装并启用官方 ClawBot 插件。

## 4. DSH（DeepSeek Harness）

- 本插件是 DSH 的第三方插件，插件接口整理稿见
  [`docs/dsh-agent-api.md`](docs/dsh-agent-api.md)；DSH 本体与其商标归 DeepSeek 所有。
