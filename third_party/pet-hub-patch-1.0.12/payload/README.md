# Friend（MCHOSE HUB 版）

把 Friend 功能实现进 MCHOSE HUB：透明置顶窗口、9 个动作、0–150% 连续缩放、
始终置顶 / 鼠标穿透 / 自动切换动作 / 跟随键鼠互动 / 按键提示 / 显示桌面等级 / 改名 / 成长等级与称号 / 位置记忆。

当前版本：见仓库根 `VERSION`（装机清单里会记下版本与装机时间）。

1.0.12：Friends 增加与 MHUB 设备页一致的主体加载过渡，等待预览素材就绪后衔接到页面；支持返回中断、慢加载重试与减少动态效果。修复插画动作的像素风重建及最近邻缩放问题，v6 管线保留原帧抗锯齿，统一预览、桌面与 GPU 补帧的平滑采样并重建缓存。

1.0.11：兼容 MHUB 2.0 解包结构；顶部改为 Friends，替换猫图标并统一为 20×20px。弹窗遮罩覆盖顶部与内容区，消除上下明暗分割。

1.0.10：新版 MHUB 使用透明文档内页，共用壁纸、原生返回箭头和完整提示气泡。进入时隐藏主页内容，返回后恢复设备卡片；新增按钮跟随光效，更新图标、字号和黑白开关。内页不开放 Node，资源与消息采用固定白名单。

1.0.9：适配新版 MHUB 的 DU 胶囊导航与玻璃材质，兼容 `MCHOSE HUB\M HUB` 下的 ASAR 结构。设计规范见 `docs/mhub-design-system.md`。新版安装会备份官方归档，卸载恢复完整原包；保留现有角色资料和设置。

1.0.8：导入取消与进度、完整图片校验、真实 2×/4× 素材、画质恢复、播报诊断、备份恢复与回收站。版本页包含构建号。详情见 `CHANGELOG.md` 和 `docs/friend-assets-v1.0.8.md`；后文的历史 1.0.7 说明以本段和新规格为准。

1.0.7：页面的「宠物 / PET」统一显示为 Friend，删除提示为「长按目标可删除」。恢复桌面拖动方向反馈：拖向左 / 右播放对应动作，同方向不重复重播，松手或取消后待机；拖动不会启动额外漫游。分发包包含此前的下载渠道、局部动效、不闪白和首页入口范围修复。

设备播报复用 MHUB 已有 `storeChange` 通道：读取 `webIndexList` 的设备类型、板载、电量和连接摘要，转发 `tipsWindowHtmlMap` 的设备通知；灯光/EQ 保留配置文件回读兜底。Friend 不另开 HID 或初始化第二套设备 SDK，启动时只建立基线，不补播旧状态。

## 一、安装（需要管理员；可重复执行）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 -NoRestart
```

脚本按顺序做七件事：

1. 停宿主进程（**只停本次安装目录的** `MCHOSE HUB.exe`，别的安装实例不受影响）；
2. 备份原始入口到 `resources\app\pet-hub\backup\index.js.orig`（只备份一次）；
3. 读上一次的装机清单，删掉「旧版本装过、新 payload 里已经没有」的陈旧文件与空目录；
4. 复制 payload 到 `MCHOSE HUB\resources\app\pet-hub`；
5. 给 `resources\app\out\main\index.js` 打一行 require（带 try/catch，失败会把堆栈写进 `pet-hub.log`）；
6. 写装机清单 `MCHOSE HUB\pet-hub-manifest.json`（版本、装机时间、安装目录、入口、排除项、完整文件清单）；
7. 文件自检（`VERSION`、`index.js`、`shared\actions.js`、`lib\config.js`、`lib\pets.js`、`lib\ipc.js`、`lib\pet-window.js`、`lib\page-view.js`、`renderer\pet\index.html`、`renderer\pet\pet.js`、`renderer\settings\index.html`、`renderer\settings\settings.js`，外加每只宠物的 `pets\<id>\pet.json`）。

常用参数：

| 参数 | 作用 |
|---|---|
| `-AppDir 'D:\MCHOSE HUB'` | 装在非默认目录时指定宿主根目录（默认 `C:\Program Files\MCHOSE HUB`） |
| `-NoRestart` | 装完不自动启动宿主 |
| `-DryRun` | 只打印计划：不停进程、不复制、不写文件，**且不需要管理员**（用来预检路径与排除项） |

payload 排除项（不进模块目录）：`scripts\`、`tests\`、`docs\`、`backup\`、`.gitignore`。另有一条历史排除项（早前的素材备份图，已移出工作树，见 `docs\reference\README.md`），名单里仍保留它、命中即跳过。

不加 `-NoRestart` 会顺带启动 MCHOSE HUB。**装失败也会把宿主重新拉起来**（宿主本来没在跑时除外），并打印入口备份路径与 uninstall 命令两条恢复路径，退出码为 1。

> 官方更新会整目录替换 `resources\app`，补丁会被抹掉。更新后重跑一次 `scripts\install.ps1` 即可（备份与用户数据都保留）。

## 二、卸载 / 还原

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall.ps1              # 还原入口 + 删除模块与装机清单
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall.ps1 -PurgeData  # 同时清掉用户数据
```

- 入口文件不存在、或不是管理员运行时直接报错退出；
- 入口文件里**没有** `pet-hub` 注入标记时不会改写它：模块目录也不存在就提示「当前已是干净状态」，否则中止并打印现场（避免把官方更新后的干净入口覆盖掉）；
- `-PurgeData` 额外删除 `%APPDATA%\MCHOSEHUB` 下的 `pet-hub.json`、`pet-hub.log`、`pet-hub.old.log` 和 `hd-cache\`（高清图集缓存，LRU 3 条 / 96MB 上限）。

## 三、多宠物

- 设置页左栏是「宠物列表」：每行两行显示 `宠物（名字）` + `Lv.N`；**点一行只改设置页的选中项（右侧面板跟着变），不会立刻切换桌面**。
- 下方主按钮只针对**当前选中的那只**：选中的那只正在桌面显示时，按钮是「隐藏宠物」（点一下隐藏）；选中的那只没在显示时，按钮是「显示宠物」（点一下直接换成它，原来那只自动被替换、桌面永远只有一只）。
- 当前真正在桌面上的那只，行尾有「显示中」小标签。
- 桌面**同时只显示一只**，切换时直接换图集、不重建窗口、不打断正在播的动作。
- 每只宠物有**独立名字与等级**（`petNames` / `growthProfiles`），切走再切回等级保留。
- 改名始终针对设置页选中的宠物，不改变桌面正在显示的宠物。动作区会说明是「仅预览」还是「预览并同步桌面动作」；仅预览时不会干扰另一只桌面宠物。
- 「试看升级特效」仅在选中的宠物已显示时可用，不会增加经验或自动显示其他宠物。
- 宠物包目录：`resources\app\pet-hub\pets\<id>\pet.json` + `spritesheet.webp`（1536×1872，8 列 × 9 行，单帧 192×208；`pet.json` 里用 `spritesheet` 字段指向图集，省略时默认 `spritesheet.webp`）。自带三只：`yorha-sit-2b`（2B）、`aby`（小猫）、`bai-yuekui`（白月魁）。
- 新增宠物：`powershell -File scripts\add-pet.ps1 -Id <id>`（默认从 `%USERPROFILE%\.codex\pets\<id>` 取，先用 `npx codex-pet-installer add <id>` 装），然后重跑 `scripts\install.ps1`（或直接把这套文件覆盖进模块目录）+ 重启宿主。

## 四、怎么用

| 入口 | 操作 |
|---|---|
| 主窗口导航 | MCHOSE HUB 顶部「神光同步 / 云端社区 / 官方商城」右侧多出一个「桌宠」tab，点它打开桌宠设置 |
| 托盘菜单 | 右键 MCHOSE HUB 托盘图标 → 桌宠 → 显示/隐藏宠物、桌宠设置、重置位置 |
| 全局热键 | `Ctrl+Alt+P` 显示/隐藏宠物；`Ctrl+Alt+O` 打开桌宠设置 |
| 桌面上 | 单击跳一下、双击挥手、按住拖动改位置、右键打开设置 |

## 五、数据与日志

- 配置：`%APPDATA%\MCHOSEHUB\pet-hub.json`（原子写、非法值自动回落默认）
- 日志：`%APPDATA%\MCHOSEHUB\pet-hub.log`（超过 1MB 轮转为 pet-hub.old.log）
- 高清图集缓存：`%APPDATA%\MCHOSEHUB\hd-cache\`（LRU 3 条、96MB 上限，`scripts\uninstall.ps1 -PurgeData` 会一并清掉）
- 宠物图集：`resources\app\pet-hub\pets\<id>\spritesheet.webp`（每只宠物一份；9 行行序：待机/向右跑/向左跑/挥手/跳跃/失败/等待/奔跑/审阅）
  早前的素材备份图已移出工作树，移到仓库外的 `D:\迈从\_ref\reference\`，仅供人工比对，不进任何构建或发布包（清单与 sha256 见 `docs\reference\README.md`）。**宿主目录 `C:\Program Files\MCHOSE HUB\resources\app\pet-hub\renderer\pet\assets\` 下现在就有同名、同 sha256（`b7e0fc61…`，51086 字节）的副本**，那是早前装机留下的；本仓库不再提供、也不再更新它。
  换素材：把新图集放到 `pets\<id>\spritesheet.webp`（必须 1536×1872、8×9）并在同目录 `pet.json` 里写 `"spritesheet": "spritesheet.webp"`，再确认每行帧数与 `shared/actions.js` 的 `durations` 长度一致。

## 六、实现要点（便于以后维护）

- 宿主主进程是 V8 字节码，我们的模块由明文入口 `out\main\index.js` 在字节码**之前** require 进来，跑在同一个 Electron 主进程里。
- 组合方式：`index.js` 装配 state（settings + growth + actions + bounds + inputAvailable + pets），广播给桌宠窗口和宿主内嵌设置页。设置页通过 `WebContentsView` 挂在宿主主窗口下，宠物窗是独立透明窗口；两者都加载本地页面，IPC 通道常量只有 `lib/ipc.js` 一处。
- 输入监听不引入原生依赖：用宿主自带 koffi 调 `user32!GetAsyncKeyState` 30ms 轮询 + `screen.getCursorScreenPoint()` 位移采样。
- 成长体系按固定规格实现：`curveVersion=1`、Lv1–30、`cost(L)=60+(L-1)*20+8*max(0,L-9)^2`、`MAX_XP=32820`、10s 冷却、5 段称号、3 位小数（出处见 `docs/pet-growth-spec.md`）。
- 托盘入口不新开图标：包装 `Tray.prototype.setContextMenu`，在宿主菜单顶部插入「桌宠」子菜单。

## 七、已知限制

1. 桌面等级徽章与升级特效的文案由渲染层生成（`升级！Lv.N` / `Level Up! Lv.N`）。
2. 键鼠监听受 Windows UIPI 影响：前台是提权窗口时可能读不到按键（任何非提权的键鼠读取方式都受这条限制）。
3. 30ms 轮询会漏掉「按下并在 30ms 内松开」的极短按键（改用 `RegisterRawInputDevices` + `WM_INPUT` 可避免漏检，本实现为不引入原生依赖而未采用）。
4. 设置页的「返回主页」撤下宿主内嵌页，恢复驱动原界面；不会关闭驱动或隐藏桌面宠物。
5. 只实现了桌宠页；宿主同页的「小木鱼」「曲谱演奏」不在本次范围。
6. 主窗口的「桌宠」tab 是注入实现的（入口注入在宿主内容帧中，设置页自身由 `WebContentsView` 承载）。宿主前端改版（换 tab 结构/换文案）后可能失效，托盘与热键不受影响。可以在 `pet-hub.json` 里设 `"pageEntry": false` 关掉它。
7. 注入成功时日志会有几条重复的 `injected into frame`（去抖重试每条路径各打一次），只是日志噪声。

## 八、自检

真机验收（重启宿主、等窗口、截图、只打印本次新增的日志）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify.ps1 -Wait 15
```

- 截图默认落在仓库同级的 `_probe\pet-verify.png`（路径由 `$PSScriptRoot` 上溯，不写死盘符）；
- **不再先删 `pet-hub.log`**：只记录重启前的长度并打印之后新增的内容，历史日志保留。

界面/逻辑回归（统一入口，跑全部探针并汇总 pass/fail）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests\run-all.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tests\run-all.ps1 -Filter t_device -TimeoutSec 600
```

- 探针目录默认是仓库同级的 `..\_probe`（可 `-ProbeDir` 指定），探针内一律用 `__dirname` 上溯定位仓库，单独 `node t_xxx.js` 也能直接跑；
- 以退出码判定通过，另解析探针打印的 `RESULT: PASS=n FAIL=n` 汇总断言数；失败会打印该探针日志末尾若干行，并以 exit 1 结束。

界面回归明细：`node ..\_verify\pet-ui-regression.js`。使用临时配置和隔离浏览器验证改名对象、独立成长、进度条、键盘弹窗、失败重试、空列表，以及中英文 1000–1920px 宽度布局；不会改写真实用户配置。

## 九、打包分发

把桌宠模块打成「解压后双击 `安装.cmd` 就能装」的分发包：收包的人不需要仓库，也不需要装 Node / git。

### 打包

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File packaging\build.ps1
# 可选参数
powershell -NoProfile -ExecutionPolicy Bypass -File packaging\build.ps1 -OutDir D:\dist -Version 1.0.1 -NoZip
```

- `-RepoRoot`：仓库根（默认是 `packaging` 的父目录）；
- `-OutDir`：产物目录（默认 `D:\迈从\dist`）；
- `-Version`：包版本（默认读仓库根 `VERSION`），**发版前先改 `VERSION` 再打包**；
- `-NoZip`：只出目录，不打 zip。

打包器先校验 `scripts\install.ps1`、`scripts\uninstall.ps1`、`scripts\detect-mhub.ps1` 与 `packaging\安装.cmd`、`packaging\卸载.cmd`、`packaging\使用说明.txt` 都在，缺哪个就报「缺少 …」并 exit 1，不会产出半成品。

### 产物

- `D:\迈从\dist\pet-hub-patch-<版本>\`：目录形态，可直接拷走；
- `D:\迈从\dist\pet-hub-patch-<版本>.zip`：给用户的压缩包，zip 内只有 `pet-hub-patch-<版本>/` 一个根文件夹，中文文件名按 UTF-8 存并置 UTF-8 标志位（不用 `Compress-Archive`，避免条目名编码问题）；
- `D:\迈从\dist\pet-hub-patch-<版本>.zip.sha256`：内容为「小写 sha256 + 两个空格 + zip 文件名」。

打完会自动自校验：必需条目齐全、没有 `scripts/`、`tests/`、`docs/`、`packaging/`、`backup/`、`.gitignore`、以及早前的素材备份图（历史排除项，见 `docs\reference\README.md`），payload 文件数与源清单一致，中文条目都带 UTF-8 标志位。任一断言不符就 exit 1，不承认该产物。

### 包内结构

```text
pet-hub-patch-<版本>/
  安装.cmd          一键入口（自提权，再调 安装.ps1，跑完停住窗口）
  安装.ps1          ← scripts\install.ps1（内容不改；同目录有 payload\ 即按分发包形态跑）
  卸载.cmd
  卸载.ps1          ← scripts\uninstall.ps1
  detect-mhub.ps1   ← scripts\detect-mhub.ps1（安装脚本按 $PSScriptRoot 找它）
  使用说明.txt
  版本信息.json     版本、构建时间、host 锚点、每个文件的 bytes + sha256
  payload\          仓库装机文件（VERSION、index.js、lib\、renderer\、shared\、pets\）
```

payload 排除规则与 `install.ps1` 一致：`scripts\`、`tests\`、`docs\`、`backup\`、`packaging\`、`.gitignore` 不进包；早前那条素材备份图排除项保留为历史项（该图已移出工作树，见 `docs\reference\README.md`）。

### 收包的人怎么装

1. 把 zip 解压到一个文件夹（不要在压缩包里直接双击）；
2. 双击「安装.cmd」，UAC 点「是」；
3. 等它自动识别 MCHOSE HUB 安装目录、打补丁并重启 MCHOSE HUB。

### 官方更新之后

MCHOSE HUB 官方更新会覆盖补丁：更新后重新双击一次「安装.cmd」即可。安装是幂等的，重复执行不会重复打补丁，也不会动用户数据与自定义宠物（都在 `%APPDATA%\MCHOSEHUB` 下）。卸载双击「卸载.cmd」，加 `-PurgeData` 连带清配置 / 日志 / 缓存。
