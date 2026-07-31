# Kotlin 原生层重构

MChat2 继续使用 React/Vite 作为界面与业务主体，Android 的 Capacitor 原生层改用 Kotlin。重构不改变 WebView 数据、Capacitor 插件名称、方法名称、备份格式或原生存储路径。

## 架构

- `MainActivity.kt`：注册 `DeviceFeatures` 与 `LargeMedia` 插件。
- `DeviceFeaturesPlugin.kt`：仅负责 Capacitor 参数、权限与 Activity 回调。
- `AttachmentService.kt`：聊天图片导入、压缩读取与角色附件清理。
- `NotificationService.kt`：通知渠道、通知展示和通知点击参数。
- `SecureStorageService.kt`：沿用 `mchat2.secure.settings` KeyStore alias 与 `mchat2_secure` SharedPreferences。
- `LargeMediaPlugin.kt`：仅负责 Capacitor 参数、文档选择器和异步调用编排。
- `MediaLibraryService.kt`：表情文件导入、ZIP 导入、删除、重命名和附件备份。
- `MediaDatabase.kt`：沿用 `mchat2-media.db`、数据库版本 1 与原有 `media` 表结构。
- `BackupArchiveService.kt`：完整备份与恢复，保留版本 1/2 清单和原有 ZIP 路径。
- `ExportSessionManager.kt`：管理分块 NDJSON 导出的临时文件。
- `NativeFileRules.kt`：集中处理文件名、MIME、canonical path 与流复制规则。

所有原生文件任务仍在单线程 I/O dispatcher 上串行执行，避免导入、删除和备份同时修改 SQLite 或媒体目录。

## 兼容边界

- 插件名保持 `DeviceFeatures` 和 `LargeMedia`。
- 13 个 `DeviceFeatures` 方法与 12 个 `LargeMedia` 方法保持不变，由 `PluginContractTest` 锁定。
- 表情库仍位于 `files/emoji-library/<roleId>`。
- 聊天附件仍位于 `files/chat-attachments/<roleId>`。
- 数据库仍为 `mchat2-media.db`，没有执行 schema migration。
- 通知 channel ID 仍为 `mchat2_replies`，通知 Intent extra 仍为 `mchat2.notification.roleId`。
- 备份仍包含 `manifest.json`、`conversations.ndjson`、`memories.ndjson`、`assets.ndjson`、`emoji-index.ndjson`、`emoji/` 与 `attachments/`。
- ZIP 条目数、单文件大小和总解压大小限制保持不变。

## 构建环境

项目使用 Kotlin 2.3.21、Android Gradle Plugin 8.13.2 和现有 Gradle 8.14.3。Gradle 构建应使用 JDK 17 或 JDK 21；JDK 25 会在当前 Gradle/Groovy 组合中报 `Unsupported class file major version 69`。

验证命令：

```powershell
npm run check
npm run build:ui
npm run lint:android
npm run test:android
npm run build:android
```

构建 APK 前必须同步提升 `package.json` 的版本、Android `versionCode` 与 `versionName`，并把产物复制为不覆盖旧文件的 `release/MChat2-v<version>.apk`。
