# v4.0.0 发布说明

作者：顾小颜

## 下载

- 文件：`M-HUB-Wallpaper-Startup-Plugin-4.0.0.exe`
- 大小：822784 字节
- SHA256：`5ed3437551c5379d5be3356cf22beed77c80069fd41a479c023034f07af2361d`

## 主要更新

- **WeGame 与自定义壁纸库**：自动发现常见 WeGame 安装目录，保留 Steam 多库支持，也可手动添加包含 `project.json` 的壁纸目录；统一去重并按来源筛选。
- **更多壁纸功能**：新增收藏、最近 30 条使用记录、全部或仅收藏范围随机切换，以及可配置间隔的定时轮换。
- **场景动态渲染**：内置离线 WebWallGL 3.0.1，支持其可解析的 `scene.pkg` / `scene.json` 项目；提供受限资源协议、单实例生命周期、裁剪适配和静态预览回退。
- **场景性能控制**：提供省电、均衡、画质三档，可设置页面隐藏时暂停渲染。
- **Apple Music 歌词适配**：识别 Windows Apple Music 进程、Store 包与 AUMID，通过系统媒体会话读取曲目和播放状态，沿用 LRCLIB、网易云歌词匹配与缓存。
- **安装器界面**：升级为深色卡片式 UI，统一安装、更新、备份、校验和卸载清单；安装器和壁纸面板均标明 v4.0.0 与作者「顾小颜」。
- **3.4.3 → 3.5.7 累积修复**：双目录安装、分阶段启动动画、歌词空闲休眠、深浅色同步、视频资源释放、缩略图回退、悬停遮挡与 Steam 多库修复统一并入本次发布，详见 `CHANGELOG.md`。

## 升级安装

1. 完全退出 M HUB。
2. 运行 `M-HUB-Wallpaper-Startup-Plugin-4.0.0.exe`，确认官方安装目录。
3. 点击「安装 / 更新」，无需先卸载旧版。
4. 启动 M HUB，在「设置 → 主题设置」中配置壁纸库、收藏、轮换和场景性能。

安装器会保留已有壁纸参数、收藏、最近记录和启动页配置，不会改写官方 `app.asar` 的内容，而是改名保留原归档并安装独立入口。

## 卸载与数据保留

再次运行安装器并选择「卸载 / 还原」，或使用：

```powershell
M-HUB-Wallpaper-Startup-Plugin-4.0.0.exe /uninstall "C:\Program Files\M HUB"
```

卸载会恢复官方归档或目录版入口、官方启动页及原 pet-hub 文件，并删除插件部署文件。以下数据不会删除：

- `%APPDATA%\MCHOSEHUB\wallpaper-hub` 中的配置、收藏与最近记录；
- Steam、WeGame 和自定义目录中的任何壁纸文件。

如果安装后官方 M HUB 已更新并重新生成 `app.asar`，请先重新安装本插件再卸载，避免旧备份覆盖新版官方文件。

## 验证结果

- 49 个 JavaScript 源文件全部通过 `node --check`。
- 主进程功能 VM 测试、场景生命周期 mock 测试、Apple Music 包/AUMID 映射纯逻辑测试通过。
- WebWallGL 3.0.1 UMD 已固定并校验，SHA256：`ee2fbe9a4d15a9ecca837c08a76b90d8c3d98dd2619976929890c9f51de2ff9c`。
- 安装器使用 .NET Framework 4.x 离线编译成功，未在构建时下载依赖。
- 隔离安装矩阵 4/4 通过：覆盖有/无 `app.asar`、有/无 unpacked renderer、`M HUB.exe` / `MCHOSE HUB.exe`、首次安装、重复安装和卸载还原；官方 asar 与目录版入口哈希均保持不变或按原值恢复。

隔离矩阵使用与发布安装器相同的 `Installer.cs` 和内嵌 payload 编译测试副本，仅将停止/重启 M HUB 两个进程控制方法替换为空操作，以免影响正在运行的真实程序。测试仅操作临时目录，未修改真实 M HUB 安装。

## 兼容与未实测边界

- 本版本尚未在真实 M HUB 上执行 4.0.0 安装与完整界面验收。
- 尚未连接真实 Apple Music 客户端或 K20 GT 设备验证；可用曲目、封面、进度与控制字段取决于 Windows 媒体会话实际提供的数据，歌词仍依赖在线源匹配或已有缓存。
- 尚未使用真实创意工坊场景和 WebGL2 宿主做真机渲染验收。场景支持范围以 WebWallGL 为准，不等同于完整复刻 Wallpaper Engine；加载或渲染失败时会回退静态预览。
- 安装器深色 UI 已通过编译，但未替代用户进行实际显示效果验收。

## 第三方许可

WebWallGL 3.0.1（作者 oneincase）使用 MIT 许可证。原始许可证和包信息随安装器部署到 `resources\app\wallpaper-hub\vendor\webwallgl\`，主项目许可证不替代第三方许可证。
