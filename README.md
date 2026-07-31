# MChat2

面向 Android 的本地 AI 角色聊天应用原型。界面使用 React 构建并通过 Capacitor 运行在 Android 原生容器中，不再提供或维护独立网页版本。

当前版本为 `0.15.0`。Android 原生层已迁移到 Kotlin，React/TypeScript 界面、Capacitor 接口、SQLite 结构、应用文件目录和完整备份格式保持兼容。

## 产品结构

- 消息：会话列表和角色列表合并为同一入口。
- 聊天：选择联系人后进入沉浸聊天，手机底栏自动隐藏。
- 角色编辑：从聊天右上角进入，管理头像、名称、介绍、角色提示词、表情包和专属聊天背景；头像与背景支持拖动缩放裁切。
- 模型与回复：配置 OpenAI 兼容 API 的请求地址、API Key、模型、温度和 Max tokens；模型列表使用应用内可搜索选择器，也可以手动输入。
- 消息队列：自动模式会合并倒计时内的连续消息；手动模式在输入框为空时点击发送按钮提交完整队列。队列会跨角色切换和应用重启恢复。
- 回复协议：连续用户消息以 $ 合并，AI 回复按 $ 拆成多条气泡；角色表情名称会注入系统提示词，模型返回的 <表情名> 会渲染为图片。
- 输入能力：支持图片附件和 Android 系统语音识别；发送后保持输入法展开。
- 设置 / 数据：管理聊天体验、系统通知，以及对话记录的选择性导入、导出和按轮次保留。

## 开发

### 环境要求

- Windows 10/11 与 PowerShell 5.1 或更高版本。
- Node.js 与 npm。
- Android SDK，当前目标版本为 API 36。
- JDK 17 或 JDK 21。项目脚本会跳过不兼容的 JDK 25，并从 `JAVA_HOME`、Android Studio JBR 和 `PATH` 中自动寻找可用 JDK。

### 常用命令

安装依赖：

```powershell
npm install
```

开发 UI：

```powershell
npm run dev
```

完整检查：

```powershell
npm run check
```

该命令依次执行 TypeScript 类型检查、ESLint、Vitest 和前端生产构建。

检查 Android Kotlin 代码：

```powershell
npm run lint:android
npm run test:android
```

其中 Android 单元测试包含文件安全规则和 25 个 Capacitor 方法的接口契约检查。

这里的开发服务器只用于调试 Android 内部 UI，不是网页端产品。

## 构建 Android APK

```powershell
npm run build:android
```

该命令会构建前端、同步 Capacitor，并使用自动找到的 JDK 17–21 执行 `assembleDebug`。

APK 输出：

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

每次正式交付 APK 前必须：

1. 提升 `package.json` 中的应用版本。
2. 提升 `android/app/build.gradle` 中的 `versionCode`，并让 `versionName` 与应用版本一致。
3. 构建完成后复制为 `release/MChat2-v<version>.apk`。
4. 不得覆盖已经存在的同版本 APK；应继续提升版本号。

打开 Android Studio：

```powershell
npm run open:android
```

## 本地数据与大文件

- 对话记录、可恢复队列和角色界面资源保存在 Android WebView 的 IndexedDB 中。
- API Key 在 Android 上由系统 Keystore 加密保存，不写入完整备份。
- 图片和文件附件由 Android 原生选择器流式复制到应用专属目录。
- 聊天界面只读取当前角色最近 200 条，完整历史由"设置 / 数据"管理。
- NDJSON 导入使用文件流逐行解析，每 500 条写入一次。
- Android 对话导出分批写入原生临时文件，再调用系统保存界面。
- 完整备份包含角色、对话、聊天图片、长期记忆、表情包和非敏感设置；恢复前会校验清单、路径与解压大小。
- 表情文件由 Android 原生选择器导入，以 1MB 缓冲区顺序复制；支持批量图片和 ZIP 压缩包流式导入。
- 表情元数据存入原生 SQLite，使用分页查询，不会一次扫描全部文件。
- 表情名称自动取自文件名，并可在角色编辑器中单独修改。
- 角色表情包可由原生代码流式压缩为 ZIP 后导出。

应用数据位于 Android 应用专属目录。卸载应用会删除本地数据，卸载前应先从设置中导出对话，并在角色编辑器中导出表情包。

当前生成的是可直接安装测试的 Debug APK。正式分发或上架前需要配置 Release 签名并生成 AAB。

## Kotlin 原生层

Capacitor 插件只负责参数转换、权限和 Activity 回调，文件、通知、数据库与备份逻辑分别放在独立 Kotlin 服务中：

- `DeviceFeaturesPlugin.kt`：图片、语音、通知和安全存储的 Capacitor 接口。
- `AttachmentService.kt`：聊天附件导入、压缩读取和清理。
- `NotificationService.kt`：通知渠道、展示和点击跳转。
- `SecureStorageService.kt`：Android Keystore 加密设置。
- `LargeMediaPlugin.kt`：媒体与备份功能的 Capacitor 接口。
- `MediaLibraryService.kt`：图片和 ZIP 导入、删除与重命名。
- `MediaDatabase.kt`：表情元数据 SQLite 仓库。
- `BackupArchiveService.kt`：完整备份与恢复，以及 ZIP 安全限制。
- `ExportSessionManager.kt`：分块 NDJSON 导出会话。
- `NativeFileRules.kt`：文件名、MIME 和 canonical path 规则。

所有原生文件任务通过单线程 I/O dispatcher 串行执行，避免导入、删除和备份同时修改 SQLite 或媒体目录。更详细的兼容边界参见 [`docs/kotlin-native-refactor.md`](docs/kotlin-native-refactor.md)。

## 项目结构

```
MChat2/
├── android/          # Android 原生项目 (Capacitor)
│   └── app/src/main/java/com/mchat2/  # Kotlin 插件与原生服务
├── assets/           # 静态资源
├── docs/             # 架构与迁移说明
├── public/           # 公共文件
├── scripts/          # JDK 选择与 Android 构建脚本
├── src/              # React 前端源码
├── index.html        # 入口 HTML
├── package.json      # 依赖与脚本
├── tsconfig.json     # TypeScript 配置
├── vite.config.ts    # Vite 构建配置
└── capacitor.config.json  # Capacitor 配置
```

## 技术栈

- **前端**: React + TypeScript + Vite
- **容器**: Capacitor (Android WebView)
- **Android 原生层**: Kotlin + Coroutines + Capacitor Plugin
- **数据存储**: IndexedDB（对话/记忆）、SQLite（表情元数据）、应用专属文件目录
- **安全存储**: Android Keystore
- **AI**: OpenAI 兼容 API
- **构建工具链**: Kotlin 2.3.21、Android Gradle Plugin 8.13.2、Gradle 8.14.3
