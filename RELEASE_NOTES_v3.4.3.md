# v3.4.3 发布说明

## 下载

- `M-HUB-Wallpaper-Startup-Plugin-3.4.3.exe`
- 大小：457728 字节
- SHA256：`fe582a1135964a307fe205ed2d9b6227b42af8cd06c26156968b0aa02109201a`

## 本次修复

- **目录版安装无法安装**：部分官方安装没有 `resources\app.asar`，入口是 `resources\app\out\main\index.js`。现在会保留官方入口为 `index.official.js` 后写入插件入口，卸载时自动还原。
- **找不到入口时提示不清**：两种入口都不存在时，会明确提示并列出 `resources` 下现有的 `.asar` 文件，便于确认是否选错安装目录。
- **播放器识别慢**：轻量轮询发现新启动的播放器进程时立即补扫，不再等 60 秒缓存过期；完整扫描加并发去重，补扫加 30 秒冷却。
- **缺少 unpacked renderer 时安装失败**：`app.asar.unpacked\bundled\renderer` 不再作为必需目录，缺失时跳过启动页备份继续安装。

## 安装

1. 关闭 M HUB；
2. 运行安装器，确认安装目录（如 `E:\MCHOSE HUB`）；
3. 启动 M HUB，进入「设置 → 主题设置」查看壁纸与启动页控制中心。

## 卸载

再次运行安装器选择「卸载 / 还原」，会恢复官方 `app.asar`（或目录版入口）与官方启动页。若安装后官方程序升级过，请先重新安装本插件再卸载，避免覆盖新版文件。

## 排查

安装或注入异常时，请附上以下日志：

- `%APPDATA%\MCHOSEHUB\wallpaper-hub\bootstrap.log`
- `%APPDATA%\MCHOSEHUB\wallpaper-hub\wallpaper-hub.log`

## 兼容说明

- 支持官方归档版与 `resources\app` 目录版两种安装结构；
- 支持有无 `app.asar.unpacked\bundled\renderer` 两种目录；
- 与歌词插件、仪表板共用同一入口，重装本插件后需重新运行它们的安装包。
