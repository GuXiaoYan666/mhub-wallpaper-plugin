using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace MHubStartupPlugin
{
    internal static class Program
    {
        internal const string ExeName = "MCHOSE HUB.exe";
        internal const string RendererRel = @"resources\app.asar.unpacked\bundled\renderer";
        internal const string AppRel = @"resources\app";
        internal const string AsarRel = @"resources\app.asar";
        internal const string UnpackedRel = @"resources\app.asar.unpacked";
        internal const string OriginalAsarRel = @"resources\app.mhub-wallpaper-original.asar";
        internal const string OriginalUnpackedRel = @"resources\app.mhub-wallpaper-original.asar.unpacked";
        internal const string PetHubRel = @"resources\app\pet-hub";
        internal const string WallpaperRel = @"resources\app\wallpaper-hub";
        internal const string ShimMarker = "M HUB startup shim";
        internal const string BootstrapMarker = "M HUB wallpaper independent bootstrap";
        internal const string BackupPrefix = "mhub-integration-backup-";
        internal const string PayloadResource = "payload.zip";

        /* startup-loading.html 在 asar 中被标记为 unpacked，Electron 会按归档文件名推导
           「<归档名>.unpacked」目录。归档改名后，启动页资源也必须位于改名后的目录。
           部分官方版本把 renderer 完全打进 app.asar，不存在 unpacked 目录，
           此时返回 null，安装器不再依赖该目录。 */
        internal static string RendererPath(string dir)
        {
            string[] candidates = new string[]
            {
                Path.Combine(dir, Program.OriginalUnpackedRel, @"bundled\renderer"),
                Path.Combine(dir, Program.RendererRel),
                Path.Combine(dir, @"resources\app\bundled\renderer"),
                Path.Combine(dir, @"resources\app\renderer")
            };
            foreach (string candidate in candidates)
            {
                if (Directory.Exists(candidate)) return candidate;
            }
            return null;
        }

        /* 备份目录优先放在 renderer（沿用旧版本目录结构以便还原）；
           没有 unpacked 资源时放到 resources 下的固定目录，卸载时同样能找到。 */
        internal static string BackupRoot(string dir)
        {
            string renderer = RendererPath(dir);
            if (renderer != null) return renderer;
            return Path.Combine(dir, @"resources\mhub-integration-backup");
        }

        private static bool _consoleReady;

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AttachConsole(int dwProcessId);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AllocConsole();

        [STAThread]
        private static int Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            string cmd = args.Length > 0 ? args[0].Trim().ToLowerInvariant() : string.Empty;

            if (cmd == "/check" || cmd == "-check" || cmd == "--check")
            {
                InitConsole();
                return RunCheck();
            }

            if (cmd == "/install" || cmd == "-install")
            {
                InitConsole();
                return RunInstallCli(args);
            }

            if (cmd == "/uninstall" || cmd == "-uninstall")
            {
                InitConsole();
                return RunUninstallCli(args);
            }

            if (args.Length > 0 && cmd != "/gui")
            {
                InitConsole();
                WriteLine("Unknown argument: " + args[0]);
                WriteLine("Usage: M-HUB-Wallpaper-Startup-Plugin.exe [/check] [/install <dir>] [/uninstall <dir>]");
                return 1;
            }

            RunGui();
            return 0;
        }

        private static int RunCheck()
        {
            string dir = Detection.Detect();
            WriteLine("M HUB Wallpaper + Startup Plugin - check");
            WriteLine("Install dir : " + (dir == null ? "(not found)" : dir));
            WriteLine("Valid       : " + (dir != null ? "YES" : "NO"));

            if (dir != null)
            {
                string renderer = Program.RendererPath(dir);
                string pethub = Path.Combine(dir, PetHubRel);
                WriteLine("Hub exe     : " + (File.Exists(Path.Combine(dir, ExeName)) ? "yes" : "no"));
                WriteLine("Renderer    : " + (renderer != null ? "yes  " + renderer : "no (bundled in app.asar)"));
                WriteLine("PetHub      : " + (Directory.Exists(pethub) ? "yes" : "no") + "  " + pethub);
                WriteLine("Wallpaper   : " + (File.Exists(Path.Combine(dir, Program.WallpaperRel, "index.js")) ? "installed" : "not installed"));
                WriteLine("Mod state   : " + (File.Exists(Path.Combine(dir, Program.WallpaperRel, @"splash\splash.js")) ? "installed" : "not installed"));
                WriteLine("Bootstrap   : " + (File.Exists(Path.Combine(dir, Program.AppRel, @"out\main\index.js")) ? "installed" : "not installed"));
                WriteLine("Lyric patch : " + (File.Exists(Path.Combine(dir, Program.AppRel, @"lyric-bridge\index.js")) ? "installed" : "not installed"));
                WriteLine("Dashboard   : " + (File.Exists(Path.Combine(dir, Program.AppRel, @"sysdeck\index.js")) ? "installed" : "not installed"));
                WriteLine("Official    : " + (File.Exists(Path.Combine(dir, Program.OriginalAsarRel)) ? "preserved original archive" : "standard archive"));
                WriteLine("Resources   : " + (Directory.Exists(Path.Combine(dir, Program.OriginalUnpackedRel)) ? "preserved original unpacked" : "standard unpacked"));
                WriteLine("Backups     : " + Installer.CountBackups(Program.BackupRoot(dir)));
            }

            WriteLine("No files were changed.");
            return dir != null ? 0 : 2;
        }

        private static int RunInstallCli(string[] args)
        {
            string dir = args.Length > 1 ? NormalizePath(args[1]) : null;
            if (string.IsNullOrEmpty(dir)) dir = Detection.Detect();
            if (!Check.IsValid(dir))
            {
                WriteLine("ERROR: M HUB install dir not found or invalid.");
                return 2;
            }
            try
            {
                InstallResult r = Installer.Install(dir, false);
                if (File.Exists(Path.Combine(dir, Program.ExeName))) Installer.RestartHub(dir);
                WriteLine("Install OK  : " + dir);
                if (!string.IsNullOrEmpty(Installer.LastNotice)) WriteLine("Notice      : " + Installer.LastNotice);
                WriteLine("Backup dir  : " + r.BackupDir);
                WriteLine("Files copied: " + r.FileCount);
                return 0;
            }
            catch (Exception ex)
            {
                WriteLine("ERROR: " + ex.Message);
                return 1;
            }
        }

        private static int RunUninstallCli(string[] args)
        {
            string dir = args.Length > 1 ? NormalizePath(args[1]) : null;
            if (string.IsNullOrEmpty(dir)) dir = Detection.Detect();
            if (!Check.IsValid(dir))
            {
                WriteLine("ERROR: M HUB install dir not found or invalid.");
                return 2;
            }
            try
            {
                UninstallResult r = Installer.Uninstall(dir);
                WriteLine("Uninstall OK: " + dir);
                WriteLine("Backup dir  : " + (r.BackupDir == null ? "(none)" : r.BackupDir));
                WriteLine("Restored    : " + r.Restored);
                WriteLine("Removed     : " + r.Removed);
                return 0;
            }
            catch (Exception ex)
            {
                WriteLine("ERROR: " + ex.Message);
                return 1;
            }
        }

        private static void RunGui()
        {
            using (MainForm form = new MainForm())
            {
                Application.Run(form);
            }
        }

        internal static string NormalizePath(string path)
        {
            if (path == null) return null;
            string p = path.Trim().Trim('"').Trim();
            if (p.Length == 0) return null;
            try { p = Path.GetFullPath(p); }
            catch { }
            p = p.TrimEnd('\\');
            if (p.Length == 2 && p[1] == ':') p += "\\";
            return p;
        }

        private static void InitConsole()
        {
            if (_consoleReady) return;
            _consoleReady = true;
            try
            {
                if (!AttachConsole(-1)) AllocConsole();
            }
            catch { }
            try
            {
                Stream stdout = Console.OpenStandardOutput();
                StreamWriter writer = new StreamWriter(stdout, new UTF8Encoding(false));
                writer.AutoFlush = true;
                Console.SetOut(writer);
            }
            catch { }
        }

        private static void WriteLine(string text)
        {
            try { Console.WriteLine(text); }
            catch { }
        }
    }

    internal static class Detection
    {
        internal static string Detect()
        {
            string fallback = null;
            foreach (string candidate in Candidates())
            {
                if (!Check.IsValid(candidate)) continue;
                string dir = Program.NormalizePath(candidate);
                if (dir == null) continue;
                if (File.Exists(Path.Combine(dir, Program.ExeName))) return dir;
                if (fallback == null) fallback = dir;
            }
            return fallback;
        }

        private static List<string> Candidates()
        {
            List<string> list = new List<string>();

            Add(list, @"C:\Program Files\M HUB");
            Add(list, @"C:\Program Files (x86)\M HUB");
            Add(list, Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "M HUB"));
            Add(list, Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "M HUB"));

            RegistryView[] views = new RegistryView[] { RegistryView.Registry64, RegistryView.Registry32 };
            RegistryHive[] hives = new RegistryHive[] { RegistryHive.LocalMachine, RegistryHive.CurrentUser };

            foreach (RegistryView view in views)
            {
                foreach (RegistryHive hive in hives)
                {
                    try
                    {
                        using (RegistryKey baseKey = RegistryKey.OpenBaseKey(hive, view))
                        using (RegistryKey uninstall = baseKey.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"))
                        {
                            if (uninstall == null) continue;
                            foreach (string subName in uninstall.GetSubKeyNames())
                            {
                                using (RegistryKey sub = uninstall.OpenSubKey(subName))
                                {
                                    if (sub == null) continue;
                                    string display = sub.GetValue("DisplayName") as string;
                                    if (string.IsNullOrEmpty(display)) continue;
                                    if (display.IndexOf("M HUB", StringComparison.OrdinalIgnoreCase) < 0 &&
                                        display.IndexOf("MCHOSE", StringComparison.OrdinalIgnoreCase) < 0) continue;

                                    Add(list, sub.GetValue("InstallLocation") as string);

                                    string icon = sub.GetValue("DisplayIcon") as string;
                                    if (!string.IsNullOrEmpty(icon))
                                    {
                                        string iconPath = icon.Trim().Trim('"');
                                        int comma = iconPath.LastIndexOf(',');
                                        if (comma > 2) iconPath = iconPath.Substring(0, comma);
                                        try
                                        {
                                            Add(list, Path.GetDirectoryName(iconPath.Trim().Trim('"')));
                                        }
                                        catch { }
                                    }
                                }
                            }
                        }
                    }
                    catch { }
                }
            }

            return list;
        }

        private static void Add(List<string> list, string path)
        {
            if (string.IsNullOrEmpty(path)) return;
            string p = path.Trim().Trim('"').Trim();
            if (p.Length == 0) return;
            foreach (string existing in list)
            {
                if (string.Equals(existing, p, StringComparison.OrdinalIgnoreCase)) return;
            }
            list.Add(p);
        }
    }

    internal static class Check
    {
        internal static bool IsValid(string dir)
        {
            if (string.IsNullOrEmpty(dir)) return false;
            try
            {
                if (!Directory.Exists(dir)) return false;
                if (File.Exists(Path.Combine(dir, Program.ExeName))) return true;
                return Directory.Exists(Path.Combine(dir, Program.RendererRel));
            }
            catch
            {
                return false;
            }
        }
    }

    internal sealed class InstallResult
    {
        internal string BackupDir;
        internal int FileCount;
    }

    internal sealed class UninstallResult
    {
        internal string BackupDir;
        internal int Restored;
        internal int Removed;
    }

    internal static class Installer
    {
        internal static readonly string[] RendererFiles = new string[]
        {
            "startup-loading.html",
            "splash.css",
            "splash.js",
            @"startup-assets\line-1.mp3",
            @"startup-assets\line-2.mp3",
            @"startup-assets\line-3.mp3",
            @"startup-assets\line-4.mp3",
            @"startup-assets\line-5.mp3",
            @"startup-assets\line-6.mp3",
            @"startup-assets\sfx-tick.mp3",
            @"startup-assets\sfx-ticks-run.mp3"
        };

        /* 启动动画资源装进插件自己的目录，由自定义协议提供给官方启动页。
           asar 只按归档索引解析文件，直接往 app.asar.unpacked 新增文件不会生效。 */
        internal static readonly string[] SplashFiles = RendererFiles;

        internal static readonly string[] WallpaperFiles = new string[]
        {
            "index.js",
            @"renderer\shell.js"
        };

        internal static readonly string[] BootstrapFiles = new string[]
        {
            "package.json",
            @"out\main\index.js"
        };

        /* 统一安装器一并部署的独立插件目录：代码各自独立，只共用加载入口。 */
        internal static readonly string[] PluginDirs = new string[]
        {
            "lyric-bridge",
            "sysdeck"
        };

        internal static string LastNotice;

        /* 安装进度回调：GUI 用它刷新日志并保持窗口不假死 */
        internal static Action<string> Progress;

        private static void Report(string text)
        {
            Action<string> p = Progress;
            if (p == null) return;
            try { p(text); } catch { }
        }

        internal static InstallResult Install(string dir, bool gui)
        {
            dir = Program.NormalizePath(dir);
            if (!Check.IsValid(dir))
                throw new InvalidOperationException("M HUB 安装目录无效：" + (dir == null ? "(空)" : dir));

            string renderer = Program.RendererPath(dir);
            string pethub = Path.Combine(dir, Program.PetHubRel);
            string wallpaper = Path.Combine(dir, Program.WallpaperRel);

            /* 有的官方版本把 renderer 整体打进 app.asar，没有 app.asar.unpacked\bundled\renderer。
               本版本不修改启动页文件，缺失该目录时跳过相关备份即可，不能因此中断安装。 */
            if (renderer == null)
                Report("未检测到 unpacked renderer，跳过启动页文件备份。");

            /* pet-hub 只是本插件的兼容 shim，不再依赖其他插件预先修改 app.asar。 */
            if (!Directory.Exists(pethub)) Directory.CreateDirectory(pethub);

            Report("正在关闭 M HUB…");
            StopHub();
            string tempDir = Path.Combine(Path.GetTempPath(), "mhub-integration-payload-" + Guid.NewGuid().ToString("N"));
            string backupDir;
            int count = 0;
            try
            {
                Report("正在解压内置文件…");
                Payload.ExtractTo(tempDir);

                /* 必须先把官方归档和它的 unpacked 资源一起改名，
                   否则启动页的 unpacked 文件仍会从旧目录读取，插件写入的启动页不会生效。 */
                Report("正在配置独立加载入口…");
                count += InstallBootstrap(dir, Path.Combine(tempDir, "bootstrap"));
                renderer = Program.RendererPath(dir);

                Report("正在备份原有文件…");
                /* 先解压再备份：备份时能和 payload 逐字节对比，
                   重复安装不会把插件自己的文件当成「原文件」备份。 */
                backupDir = Backup.Create(dir, renderer, pethub, wallpaper, tempDir);

                Report("正在写入插件文件…");
                count += CopyFiles(Path.Combine(tempDir, "renderer"), Path.Combine(wallpaper, "splash"), SplashFiles);
                count += CopyFiles(Path.Combine(tempDir, "wallpaper-hub"), wallpaper, WallpaperFiles);
                foreach (string plugin in PluginDirs)
                {
                    string sourceTree = Path.Combine(tempDir, plugin);
                    if (!Directory.Exists(sourceTree)) continue;
                    count += CopyTree(sourceTree, Path.Combine(dir, Program.AppRel, plugin));
                }

                string indexJs = Path.Combine(pethub, "index.js");
                string indexOriginal = Path.Combine(pethub, "index.original.js");
                string payloadShim = Path.Combine(tempDir, "pethub", "index.js");
                /* 只有真正的第三方 pet-hub 才需要留底；旧版本误把本插件 shim 复制成
                   index.original.js 的残留也在这里清掉，避免卸载后留下无用文件。 */
                if (File.Exists(indexOriginal) && SameBytes(indexOriginal, payloadShim))
                {
                    try { File.Delete(indexOriginal); } catch { }
                }
                if (File.Exists(indexJs) && !File.Exists(indexOriginal) && !SameBytes(indexJs, payloadShim))
                {
                    string existing = string.Empty;
                    try { existing = File.ReadAllText(indexJs); }
                    catch { }
                    if (existing.IndexOf(Program.ShimMarker, StringComparison.Ordinal) < 0)
                        File.Copy(indexJs, indexOriginal, true);
                }
                File.Copy(payloadShim, indexJs, true);
                count++;

                VerifyInstallation(dir, tempDir);
            }
            finally
            {
                try { if (Directory.Exists(tempDir)) Directory.Delete(tempDir, true); }
                catch { }
            }

            if (gui && File.Exists(Path.Combine(dir, Program.ExeName)))
            {
                DialogResult answer = MessageBox.Show(
                    "壁纸与启动页增强插件已安装，原有壁纸参数和启动页配置均已保留。\r\n\r\n是否立即重启 M HUB 以查看效果？",
                    "重启 M HUB", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
                if (answer == DialogResult.Yes) RestartHub(dir);
            }

            InstallResult result = new InstallResult();
            result.BackupDir = backupDir;
            result.FileCount = count;
            LastNotice = "已启用独立加载入口，无需预先安装 pet-hub；官方程序归档内容未改动。";
            return result;
        }

        private static int CopyFiles(string sourceRoot, string targetRoot, string[] files)
        {
            int count = 0;
            foreach (string rel in files)
            {
                string source = Path.Combine(sourceRoot, rel);
                if (!File.Exists(source))
                    throw new FileNotFoundException("内置 payload 缺少文件：" + rel, source);
                string target = Path.Combine(targetRoot, rel);
                Directory.CreateDirectory(Path.GetDirectoryName(target));
                File.Copy(source, target, true);
                count++;
            }
            return count;
        }

        /* 逐字节比较，用于判断某个文件是否就是本插件写过的版本。 */
        internal static bool SameBytes(string left, string right)
        {
            try
            {
                if (!File.Exists(left) || !File.Exists(right)) return false;
                if (new FileInfo(left).Length != new FileInfo(right).Length) return false;
                using (FileStream sa = File.OpenRead(left))
                using (FileStream sb = File.OpenRead(right))
                {
                    byte[] ba = new byte[64 * 1024];
                    byte[] bb = new byte[64 * 1024];
                    while (true)
                    {
                        int na = sa.Read(ba, 0, ba.Length);
                        int nb = sb.Read(bb, 0, bb.Length);
                        if (na != nb) return false;
                        if (na == 0) return true;
                        for (int i = 0; i < na; i++)
                            if (ba[i] != bb[i]) return false;
                    }
                }
            }
            catch
            {
                return false;
            }
        }

        private static int InstallBootstrap(string dir, string sourceRoot)
        {
            string appDir = Path.Combine(dir, Program.AppRel);
            string asar = Path.Combine(dir, Program.AsarRel);
            string original = Path.Combine(dir, Program.OriginalAsarRel);
            if (!File.Exists(asar) && !File.Exists(original))
                throw new InvalidOperationException("未找到 M HUB 官方 app.asar，无法配置独立加载入口。");

            Directory.CreateDirectory(appDir);
            int count = CopyFiles(sourceRoot, appDir, BootstrapFiles);

            /* 旧版本入口文件：升级时清掉，避免它和应用目录里的新入口同时存在。 */
            string legacy = Path.Combine(appDir, "mhub-wallpaper-bootstrap.js");
            if (File.Exists(legacy))
            {
                try
                {
                    if (File.ReadAllText(legacy).IndexOf(Program.BootstrapMarker, StringComparison.Ordinal) >= 0)
                        File.Delete(legacy);
                }
                catch { }
            }

            /* Electron 优先加载 app.asar；仅在没有 app.asar 时才使用 resources\app。
               因此保留官方归档的原始字节并改名，由外层 bootstrap 再 require 它。 */
            if (File.Exists(asar))
            {
                if (!File.Exists(original))
                {
                    File.Move(asar, original);
                }
                else
                {
                    /* 官方更新可能重新生成 app.asar：更新保留的归档，不降级到旧版本。 */
                    string staging = original + ".new-" + Guid.NewGuid().ToString("N");
                    try
                    {
                        File.Copy(asar, staging, true);
                        if (new FileInfo(asar).Length != new FileInfo(staging).Length)
                            throw new IOException("官方归档复制校验失败。");
                        File.Copy(staging, original, true);
                        File.Delete(asar);
                    }
                    finally
                    {
                        try { if (File.Exists(staging)) File.Delete(staging); } catch { }
                    }
                }
            }

            /* asar 里的 startup-loading.html / openanimation.mp4 是 unpacked 文件，
               Electron 按归档名推导目录，所以这个目录必须跟着归档一起改名。 */
            string unpacked = Path.Combine(dir, Program.UnpackedRel);
            string originalUnpacked = Path.Combine(dir, Program.OriginalUnpackedRel);
            if (Directory.Exists(unpacked))
            {
                if (!Directory.Exists(originalUnpacked))
                {
                    Directory.Move(unpacked, originalUnpacked);
                }
                else
                {
                    /* 官方更新重新生成了 unpacked 资源：以官方文件覆盖保留副本。 */
                    OverwriteDirectory(unpacked, originalUnpacked);
                    Directory.Delete(unpacked, true);
                }
            }
            return count;
        }

        private static void OverwriteDirectory(string source, string target)
        {
            Directory.CreateDirectory(target);
            foreach (string file in Directory.GetFiles(source))
            {
                File.Copy(file, Path.Combine(target, Path.GetFileName(file)), true);
            }
            foreach (string child in Directory.GetDirectories(source))
            {
                OverwriteDirectory(child, Path.Combine(target, Path.GetFileName(child)));
            }
        }

        private static int CopyTree(string source, string target)
        {
            Directory.CreateDirectory(target);
            int count = 0;
            foreach (string file in Directory.GetFiles(source))
            {
                File.Copy(file, Path.Combine(target, Path.GetFileName(file)), true);
                count++;
            }
            foreach (string child in Directory.GetDirectories(source))
            {
                count += CopyTree(child, Path.Combine(target, Path.GetFileName(child)));
            }
            return count;
        }

        private static void VerifyInstallation(string dir, string payloadRoot)
        {
            string original = Path.Combine(dir, Program.OriginalAsarRel);
            string asar = Path.Combine(dir, Program.AsarRel);
            string bootstrap = Path.Combine(dir, Program.AppRel, @"out\main\index.js");
            string shim = Path.Combine(dir, Program.PetHubRel, "index.js");
            string renderer = Program.RendererPath(dir);
            if (!File.Exists(original)) throw new IOException("安装校验失败：官方归档备份不存在。");
            if (File.Exists(asar)) throw new IOException("安装校验失败：app.asar 仍占用入口，请关闭 M HUB 后重试。");
            if (!File.Exists(bootstrap) || File.ReadAllText(bootstrap).IndexOf(Program.BootstrapMarker, StringComparison.Ordinal) < 0)
                throw new IOException("安装校验失败：独立加载入口未正确写入。");
            if (!File.Exists(shim) || File.ReadAllText(shim).IndexOf(Program.ShimMarker, StringComparison.Ordinal) < 0)
                throw new IOException("安装校验失败：启动页保护模块未正确写入。");
            if (!File.Exists(Path.Combine(dir, Program.WallpaperRel, "index.js")) ||
                !File.Exists(Path.Combine(dir, Program.WallpaperRel, @"renderer\shell.js")))
                throw new IOException("安装校验失败：壁纸插件文件不完整。");

            /* 关键校验：启动动画资源必须落在插件自己目录；官方启动页本身只作为宿主窗口。 */
            string splashDir = Path.Combine(dir, Program.WallpaperRel, "splash");
            string[] splashCheck = new string[] { "splash.js", "splash.css", "startup-loading.html" };
            foreach (string name in splashCheck)
            {
                if (!SameBytes(Path.Combine(splashDir, name), Path.Combine(payloadRoot, "renderer", name)))
                    throw new IOException("安装校验失败：启动动画资源未写入（" + name + "）。请关闭 M HUB 后重试。");
            }
            if (renderer != null && !File.Exists(Path.Combine(renderer, "startup-loading.html")))
                throw new IOException("安装校验失败：官方启动页缺失，无法挂载启动动画。");
            if (!File.Exists(Path.Combine(splashDir, @"startup-assets\line-1.mp3")))
                throw new IOException("安装校验失败：启动动画音效缺失。");

            foreach (string plugin in PluginDirs)
            {
                string installed = Path.Combine(dir, Program.AppRel, plugin, "index.js");
                string expected = Path.Combine(payloadRoot, plugin, "index.js");
                if (!SameBytes(installed, expected))
                    throw new IOException("安装校验失败：" + plugin + " 插件未正确写入。");
            }
        }

        private static void RestoreArchive(string dir)
        {
            string asar = Path.Combine(dir, Program.AsarRel);
            string original = Path.Combine(dir, Program.OriginalAsarRel);
            string unpacked = Path.Combine(dir, Program.UnpackedRel);
            string originalUnpacked = Path.Combine(dir, Program.OriginalUnpackedRel);

            if (File.Exists(original))
            {
                if (File.Exists(asar))
                    throw new InvalidOperationException("检测到 M HUB 更新后的新 app.asar。为避免覆盖新版，已停止还原；请先重新安装本插件，再卸载。");
                File.Move(original, asar);
            }

            if (Directory.Exists(originalUnpacked))
            {
                if (Directory.Exists(unpacked))
                    throw new InvalidOperationException("检测到 M HUB 更新后的新 app.asar.unpacked。为避免覆盖新版，已停止还原；请先重新安装本插件，再卸载。");
                Directory.Move(originalUnpacked, unpacked);
            }
        }

        internal static UninstallResult Uninstall(string dir)
        {
            dir = Program.NormalizePath(dir);
            if (!Check.IsValid(dir))
                throw new InvalidOperationException("M HUB 安装目录无效：" + (dir == null ? "(空)" : dir));

            string renderer = Program.RendererPath(dir);
            string backupRoot = Program.BackupRoot(dir);
            string pethub = Path.Combine(dir, Program.PetHubRel);
            string wallpaper = Path.Combine(dir, Program.WallpaperRel);
            Report("正在关闭 M HUB…");
            StopHub();

            UninstallResult result = new UninstallResult();
            string backupDir = FindLatestBackup(backupRoot);
            result.BackupDir = backupDir;

            /* 重复安装会产生多个备份。卸载必须从最早的备份出发：
               最早那份才是真正的用户原文件，后来的备份大多是插件自己的文件。 */
            Dictionary<string, string> restores = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            HashSet<string> deletes = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            List<string> usedBackups = new List<string>();

            foreach (string oneBackup in ListBackupsOldestFirst(backupRoot))
            {
                string manifest = Path.Combine(oneBackup, "manifest.txt");
                if (!File.Exists(manifest)) continue;
                usedBackups.Add(oneBackup);

                /* 旧版本安装时目录名是 app.asar.unpacked，备份里记录的是当时的绝对路径。
                   统一换算到当前 renderer 目录，避免还原时又生成一个旧目录。 */
                string recordedRenderer = null;
                foreach (string rawLine in File.ReadAllLines(manifest, Encoding.UTF8))
                {
                    string probe = rawLine.Trim();
                    if (probe.StartsWith("renderer=", StringComparison.OrdinalIgnoreCase))
                    {
                        recordedRenderer = probe.Substring(9).Trim();
                        break;
                    }
                }

                foreach (string rawLine in File.ReadAllLines(manifest, Encoding.UTF8))
                {
                    string line = rawLine.Trim();
                    if (line.Length == 0 || line[0] == '#') continue;
                    if (line.StartsWith("file=", StringComparison.OrdinalIgnoreCase))
                    {
                        string body = line.Substring(5);
                        int bar = body.LastIndexOf('|');
                        if (bar <= 0) continue;
                        string absolute = NormalizeBackupPath(body.Substring(0, bar), recordedRenderer, renderer);
                        string relative = body.Substring(bar + 1);
                        string source = Path.Combine(oneBackup, relative);
                        if (!File.Exists(source)) continue;
                        if (!restores.ContainsKey(absolute)) restores[absolute] = source;
                        deletes.Remove(absolute);
                    }
                    else if (line.StartsWith("add=", StringComparison.OrdinalIgnoreCase))
                    {
                        string absolute = NormalizeBackupPath(line.Substring(4), recordedRenderer, renderer);
                        if (!restores.ContainsKey(absolute)) deletes.Add(absolute);
                    }
                }
            }

            foreach (KeyValuePair<string, string> item in restores)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(item.Key));
                File.Copy(item.Value, item.Key, true);
                result.Restored++;
            }

            foreach (string absolute in deletes)
            {
                if (File.Exists(absolute) && IsModFile(renderer, pethub, wallpaper, absolute))
                {
                    File.Delete(absolute);
                    result.Removed++;
                }
            }

            string legacyBootstrap = Path.Combine(dir, Program.AppRel, "mhub-wallpaper-bootstrap.js");
            if (File.Exists(legacyBootstrap))
            {
                try
                {
                    if (File.ReadAllText(legacyBootstrap).IndexOf(Program.BootstrapMarker, StringComparison.Ordinal) >= 0)
                        File.Delete(legacyBootstrap);
                }
                catch { }
            }

            string indexOriginal = Path.Combine(pethub, "index.original.js");
            string indexJs = Path.Combine(pethub, "index.js");
            if (File.Exists(indexOriginal))
            {
                string current = string.Empty;
                try { if (File.Exists(indexJs)) current = File.ReadAllText(indexJs); }
                catch { }
                if (current.IndexOf(Program.ShimMarker, StringComparison.Ordinal) >= 0)
                {
                    File.Copy(indexOriginal, indexJs, true);
                    result.Restored++;
                }
            }

            Report("正在还原官方加载入口…");
            foreach (string oneBackup in usedBackups)
            {
                /* 备份目录位于当前 renderer 内；必须在目录改名回 app.asar.unpacked 之前清理。 */
                try { if (Directory.Exists(oneBackup)) Directory.Delete(oneBackup, true); }
                catch { }
            }
            RemoveEmptyDirectory(backupRoot);
            RestoreArchive(dir);

            foreach (string plugin in PluginDirs)
            {
                string pluginDir = Path.Combine(dir, Program.AppRel, plugin);
                if (!Directory.Exists(pluginDir)) continue;
                try
                {
                    Directory.Delete(pluginDir, true);
                    result.Removed++;
                }
                catch { }
            }

            RemoveEmptyDirectory(Path.Combine(wallpaper, "renderer"));
            RemoveEmptyDirectory(Path.Combine(wallpaper, "splash", "startup-assets"));
            RemoveEmptyDirectory(Path.Combine(wallpaper, "splash"));
            RemoveEmptyDirectory(wallpaper);
            RemoveEmptyDirectory(pethub);
            RemoveEmptyDirectory(Path.Combine(dir, Program.AppRel, "out", "main"));
            RemoveEmptyDirectory(Path.Combine(dir, Program.AppRel, "out"));
            RemoveEmptyDirectory(Path.Combine(dir, Program.AppRel));
            if (result.Restored == 0 && result.Removed == 0)
                throw new InvalidOperationException("没有找到可还原的备份，安装目录可能未安装本插件。");
            return result;
        }

        private static string NormalizeBackupPath(string absolute, string recordedRenderer, string renderer)
        {
            if (string.IsNullOrEmpty(recordedRenderer) || string.IsNullOrEmpty(absolute)) return absolute;
            if (string.IsNullOrEmpty(renderer)) return absolute;
            if (absolute.StartsWith(recordedRenderer, StringComparison.OrdinalIgnoreCase))
                return renderer + absolute.Substring(recordedRenderer.Length);
            return absolute;
        }

        private static void RemoveEmptyDirectory(string dir)
        {
            try
            {
                if (Directory.Exists(dir) && Directory.GetFileSystemEntries(dir).Length == 0)
                    Directory.Delete(dir);
            }
            catch { }
        }

        internal static int CountBackups(string renderer)
        {
            try
            {
                if (!Directory.Exists(renderer)) return 0;
                return Directory.GetDirectories(renderer, Program.BackupPrefix + "*").Length;
            }
            catch
            {
                return 0;
            }
        }

        private static string[] ListBackupsOldestFirst(string renderer)
        {
            try
            {
                if (!Directory.Exists(renderer)) return new string[0];
                string[] dirs = Directory.GetDirectories(renderer, Program.BackupPrefix + "*");
                Array.Sort(dirs, delegate(string a, string b)
                {
                    return string.Compare(a, b, StringComparison.OrdinalIgnoreCase);
                });
                return dirs;
            }
            catch
            {
                return new string[0];
            }
        }

        private static string FindLatestBackup(string renderer)
        {
            try
            {
                if (!Directory.Exists(renderer)) return null;
                string[] dirs = Directory.GetDirectories(renderer, Program.BackupPrefix + "*");
                if (dirs.Length == 0) return null;
                Array.Sort(dirs, delegate(string a, string b)
                {
                    return string.Compare(b, a, StringComparison.OrdinalIgnoreCase);
                });
                foreach (string d in dirs)
                {
                    if (File.Exists(Path.Combine(d, "manifest.txt"))) return d;
                }
                return dirs[0];
            }
            catch
            {
                return null;
            }
        }

        private static bool IsModFile(string renderer, string pethub, string wallpaper, string absolute)
        {
            foreach (string rel in SplashFiles)
            {
                if (string.Equals(absolute, Path.Combine(wallpaper, "splash", rel), StringComparison.OrdinalIgnoreCase))
                    return true;
            }
            foreach (string rel in WallpaperFiles)
            {
                if (string.Equals(absolute, Path.Combine(wallpaper, rel), StringComparison.OrdinalIgnoreCase))
                    return true;
            }
            foreach (string rel in BootstrapFiles)
            {
                if (string.Equals(absolute, Path.Combine(Path.GetDirectoryName(pethub), rel), StringComparison.OrdinalIgnoreCase))
                    return true;
            }
            return string.Equals(absolute, Path.Combine(pethub, "index.js"), StringComparison.OrdinalIgnoreCase);
        }

        private static void StopHub()
        {
            /* 一次结束所有进程，再统一限时等待：之前是每个进程各等 8 秒，
               M HUB 有 8~10 个同名进程时最坏要卡一分多钟。 */
            bool stopped = false;
            for (int round = 0; round < 3; round++)
            {
                Process[] list = Process.GetProcessesByName("MCHOSE HUB");
                if (list.Length == 0) break;
                stopped = true;
                foreach (Process process in list)
                {
                    try { process.Kill(); }
                    catch { }
                }
                DateTime deadline = DateTime.UtcNow.AddMilliseconds(1500);
                foreach (Process process in list)
                {
                    try
                    {
                        int remain = (int)Math.Max(0, (deadline - DateTime.UtcNow).TotalMilliseconds);
                        if (remain > 0) process.WaitForExit(remain);
                    }
                    catch { }
                }
            }
            if (stopped) Thread.Sleep(500);
        }

        internal static void RestartHub(string dir)
        {
            StopHub();
            try
            {
                ProcessStartInfo info = new ProcessStartInfo(Path.Combine(dir, Program.ExeName));
                info.WorkingDirectory = dir;
                info.UseShellExecute = true;
                Process.Start(info);
            }
            catch { }
        }
    }

    internal static class Backup
    {
        internal static string Create(string dir, string renderer, string pethub, string wallpaper, string payloadRoot)
        {
            string backupRoot = string.IsNullOrEmpty(renderer) ? Program.BackupRoot(dir) : renderer;
            string stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss");
            string backupDir = Path.Combine(backupRoot, Program.BackupPrefix + stamp);
            int index = 2;
            while (Directory.Exists(backupDir))
            {
                backupDir = Path.Combine(backupRoot, Program.BackupPrefix + stamp + "-" + index);
                index++;
            }
            Directory.CreateDirectory(backupDir);

            List<string> lines = new List<string>();
            lines.Add("# M HUB wallpaper and startup integration backup");
            lines.Add("created=" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"));
            lines.Add("renderer=" + (renderer ?? string.Empty));
            lines.Add("pethub=" + pethub);
            lines.Add("wallpaper=" + wallpaper);
            BackupFiles(backupDir, lines, Path.Combine(wallpaper, "splash"), Installer.SplashFiles, "splash", Path.Combine(payloadRoot, "renderer"));
            BackupFiles(backupDir, lines, wallpaper, Installer.WallpaperFiles, "wallpaper-hub", Path.Combine(payloadRoot, "wallpaper-hub"));
            BackupFiles(backupDir, lines, Path.Combine(dir, Program.AppRel), Installer.BootstrapFiles, "bootstrap", Path.Combine(payloadRoot, "bootstrap"));
            lines.Add("originalAsar=" + Path.Combine(dir, Program.OriginalAsarRel));

            string indexJs = Path.Combine(pethub, "index.js");
            string payloadShim = Path.Combine(payloadRoot, "pethub", "index.js");
            string rel = @"pet-hub\index.js";
            if (!File.Exists(indexJs)) lines.Add("add=" + indexJs);
            else if (Installer.SameBytes(indexJs, payloadShim))
            {
                /* 重复安装时 index.js 已经是本插件的 shim：卸载时应当删除，而不是再次备份。 */
                lines.Add("add=" + indexJs);
            }
            else
            {
                string text = string.Empty;
                try { text = File.ReadAllText(indexJs); }
                catch { }
                if (text.IndexOf(Program.ShimMarker, StringComparison.Ordinal) >= 0)
                    lines.Add("add=" + indexJs);
                else
                {
                    CopyInto(backupDir, rel, indexJs);
                    lines.Add("file=" + indexJs + "|" + rel);
                }
            }

            File.WriteAllText(
                Path.Combine(backupDir, "manifest.txt"),
                string.Join("\r\n", lines.ToArray()) + "\r\n",
                new UTF8Encoding(true));
            return backupDir;
        }

        private static void BackupFiles(
            string backupDir,
            List<string> lines,
            string sourceRoot,
            string[] files,
            string backupPrefix,
            string payloadDir
        )
        {
            foreach (string rel in files)
            {
                string source = Path.Combine(sourceRoot, rel);
                string backupRel = string.IsNullOrEmpty(backupPrefix) ? rel : Path.Combine(backupPrefix, rel);
                if (!File.Exists(source))
                {
                    lines.Add("add=" + source);
                    continue;
                }

                /* 内容与本插件 payload 一致，说明是上一次安装写入的，不是用户原文件。 */
                string payloadFile = Path.Combine(payloadDir, rel);
                if (Installer.SameBytes(source, payloadFile))
                {
                    lines.Add("add=" + source);
                    continue;
                }

                CopyInto(backupDir, backupRel, source);
                lines.Add("file=" + source + "|" + backupRel);
            }
        }

        private static void CopyInto(string backupDir, string relative, string source)
        {
            string target = Path.Combine(backupDir, relative);
            Directory.CreateDirectory(Path.GetDirectoryName(target));
            File.Copy(source, target, true);
        }
    }

    internal static class Payload
    {
        internal static void ExtractTo(string destination)
        {
            Assembly assembly = Assembly.GetExecutingAssembly();
            Stream stream = assembly.GetManifestResourceStream(Program.PayloadResource);

            if (stream == null)
            {
                foreach (string name in assembly.GetManifestResourceNames())
                {
                    if (name.EndsWith("payload.zip", StringComparison.OrdinalIgnoreCase))
                    {
                        stream = assembly.GetManifestResourceStream(name);
                        break;
                    }
                }
            }

            if (stream == null)
                throw new InvalidOperationException("内置 payload.zip 未找到，安装包可能已损坏。");

            Directory.CreateDirectory(destination);

            using (stream)
            using (ZipArchive archive = new ZipArchive(stream, ZipArchiveMode.Read))
            {
                foreach (ZipArchiveEntry entry in archive.Entries)
                {
                    string name = entry.FullName.Replace('/', '\\');
                    if (name.EndsWith("\\")) continue;

                    string target = Path.Combine(destination, name);
                    Directory.CreateDirectory(Path.GetDirectoryName(target));

                    using (Stream input = entry.Open())
                    using (FileStream output = File.Create(target))
                    {
                        input.CopyTo(output);
                    }
                }
            }
        }
    }

    /* 安装/还原进度窗口：后台线程只写状态字符串，UI 线程用定时器刷新，
       不跨线程 Invoke，窗口始终保持响应。 */
    internal sealed class WaitForm : Form
    {
        private readonly Label _status = new Label();
        private readonly ProgressBar _bar = new ProgressBar();
        private readonly System.Windows.Forms.Timer _timer = new System.Windows.Forms.Timer();
        private volatile string _pending;
        private volatile bool _done;

        internal WaitForm(string title, string status)
        {
            Text = title;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterParent;
            ClientSize = new Size(420, 108);
            ControlBox = false;
            MinimizeBox = false;
            MaximizeBox = false;
            ShowInTaskbar = false;
            TopMost = true;

            _status.Text = status;
            _status.SetBounds(18, 18, 384, 22);
            _status.Font = new Font("Microsoft YaHei UI", 9f);
            Controls.Add(_status);

            _bar.SetBounds(18, 50, 384, 16);
            _bar.Style = ProgressBarStyle.Marquee;
            _bar.MarqueeAnimationSpeed = 24;
            Controls.Add(_bar);

            _timer.Interval = 120;
            _timer.Tick += delegate
            {
                string text = _pending;
                if (text != null)
                {
                    _pending = null;
                    _status.Text = text;
                }
                if (_done)
                {
                    _timer.Stop();
                    Close();
                }
            };
            _timer.Start();
        }

        internal void SetStatus(string text)
        {
            _pending = text;
        }

        internal void MarkDone()
        {
            _done = true;
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            _timer.Stop();
            _timer.Dispose();
            base.OnFormClosed(e);
        }
    }

    internal sealed class MainForm : Form
    {
        private readonly TextBox _pathBox = new TextBox();
        private readonly TextBox _logBox = new TextBox();
        private readonly Button _installButton = new Button();
        private readonly Button _uninstallButton = new Button();

        internal MainForm()
        {
            Text = "M HUB 壁纸与启动页增强插件";
            ClientSize = new Size(640, 430);
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            Font = new Font("Microsoft YaHei UI", 9f);

            Label title = new Label();
            title.Text = "M HUB 壁纸与启动页增强插件";
            title.Font = new Font("Microsoft YaHei UI", 15f, FontStyle.Bold);
            title.SetBounds(20, 14, 580, 36);
            Controls.Add(title);

            Label subtitle = new Label();
            subtitle.Text = "集成 Wallpaper Engine 壁纸、美化参数、启动页控制面板、动画与音效。保留上次设置，安装前自动备份。";
            subtitle.SetBounds(22, 52, 580, 36);
            Controls.Add(subtitle);

            Label dirLabel = new Label();
            dirLabel.Text = "M HUB 安装目录：";
            dirLabel.SetBounds(20, 100, 118, 22);
            Controls.Add(dirLabel);

            _pathBox.SetBounds(140, 98, 360, 25);
            _pathBox.ReadOnly = true;
            _pathBox.BackColor = SystemColors.Window;
            Controls.Add(_pathBox);

            Button browseButton = new Button();
            browseButton.Text = "浏览...";
            browseButton.SetBounds(510, 97, 90, 27);
            browseButton.Click += BrowseButtonClick;
            Controls.Add(browseButton);

            _installButton.Text = "安装 / 更新";
            _installButton.SetBounds(20, 140, 180, 42);
            _installButton.Click += InstallButtonClick;
            Controls.Add(_installButton);

            _uninstallButton.Text = "卸载 / 还原";
            _uninstallButton.SetBounds(212, 140, 180, 42);
            _uninstallButton.Click += UninstallButtonClick;
            Controls.Add(_uninstallButton);

            Button closeButton = new Button();
            closeButton.Text = "关闭";
            closeButton.SetBounds(510, 140, 90, 42);
            closeButton.Click += delegate { Close(); };
            Controls.Add(closeButton);

            _logBox.SetBounds(20, 196, 580, 200);
            _logBox.Multiline = true;
            _logBox.ReadOnly = true;
            _logBox.ScrollBars = ScrollBars.Vertical;
            _logBox.BackColor = Color.FromArgb(250, 250, 250);
            _logBox.Font = new Font("Consolas", 9f);
            Controls.Add(_logBox);

            Shown += delegate
            {
                string detected = Detection.Detect();
                if (detected != null)
                {
                    _pathBox.Text = detected;
                    Log("已检测到安装目录：" + detected);
                }
                else
                {
                    Log("未自动检测到 M HUB 安装目录，请手动选择。");
                    BrowseForFolder();
                }
            };
        }

        private void BrowseButtonClick(object sender, EventArgs e)
        {
            BrowseForFolder();
        }

        private void BrowseForFolder()
        {
            using (FolderBrowserDialog dialog = new FolderBrowserDialog())
            {
                dialog.Description = "请选择 M HUB 安装目录（包含 MCHOSE HUB.exe 的文件夹）";
                dialog.ShowNewFolderButton = false;
                if (Directory.Exists(@"C:\Program Files\M HUB"))
                    dialog.SelectedPath = @"C:\Program Files\M HUB";

                if (dialog.ShowDialog(this) != DialogResult.OK) return;

                string picked = Program.NormalizePath(dialog.SelectedPath);
                if (!Check.IsValid(picked))
                {
                    MessageBox.Show(this,
                        "所选目录不是有效的 M HUB 安装目录。\r\n\r\n目录中应包含 MCHOSE HUB.exe，或存在 resources\\app.asar.unpacked\\bundled\\renderer 目录。",
                        "目录无效", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return;
                }

                _pathBox.Text = picked;
                Log("已选择安装目录：" + picked);
            }
        }

        private void InstallButtonClick(object sender, EventArgs e)
        {
            string dir = Program.NormalizePath(_pathBox.Text);
            if (!Check.IsValid(dir))
            {
                MessageBox.Show(this,
                    "当前目录不是有效的 M HUB 安装目录，请点击「浏览...」重新选择。",
                    "目录无效", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            if (!File.Exists(Path.Combine(dir, Program.ExeName)))
            {
                DialogResult confirm = MessageBox.Show(this,
                    "该目录中没有找到 MCHOSE HUB.exe，仍要继续安装吗？",
                    "确认", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
                if (confirm != DialogResult.Yes) return;
            }

            Cursor = Cursors.WaitCursor;
            _installButton.Enabled = false;
            _uninstallButton.Enabled = false;
            InstallResult result = null;
            Exception error = null;
            using (WaitForm wait = new WaitForm("安装中", "正在准备…"))
            {
                /* 安装放到后台线程，UI 线程只跑消息循环：窗口不会「未响应」 */
                Installer.Progress = delegate(string s) { wait.SetStatus(s); };
                Thread worker = new Thread(delegate()
                {
                    try { result = Installer.Install(dir, false); }
                    catch (Exception ex) { error = ex; }
                    finally
                    {
                        Installer.Progress = null;
                        wait.MarkDone();
                    }
                });
                worker.IsBackground = true;
                worker.Start();
                wait.ShowDialog(this);
                worker.Join(3000);
            }
            _installButton.Enabled = true;
            _uninstallButton.Enabled = true;
            Cursor = Cursors.Default;

            if (error != null)
            {
                Log("安装失败：" + error.Message);
                MessageBox.Show(this, "安装失败：\r\n\r\n" + error.Message, "错误", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            Log("安装完成，写入 " + result.FileCount + " 个文件。");
            if (!string.IsNullOrEmpty(Installer.LastNotice)) Log(Installer.LastNotice);
            Log("已保留上次的壁纸参数与启动页配置。");
            Log("备份目录：" + result.BackupDir);

            MessageBox.Show(this,
                "安装成功！\r\n\r\n共写入 " + result.FileCount + " 个文件。\r\n\r\n备份目录：\r\n" + result.BackupDir +
                "\r\n\r\n如需还原，请点击「卸载 / 还原」。",
                "安装完成", MessageBoxButtons.OK, MessageBoxIcon.Information);

            if (File.Exists(Path.Combine(dir, Program.ExeName)))
            {
                DialogResult answer = MessageBox.Show(this,
                    "是否立即重启 M HUB 以查看效果？",
                    "重启 M HUB", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
                if (answer == DialogResult.Yes)
                {
                    Log("正在重启 M HUB…");
                    Installer.RestartHub(dir);
                    Log("已启动 M HUB。");
                }
            }
        }

        private void UninstallButtonClick(object sender, EventArgs e)
        {
            string dir = Program.NormalizePath(_pathBox.Text);
            if (!Check.IsValid(dir))
            {
                MessageBox.Show(this,
                    "当前目录不是有效的 M HUB 安装目录，请点击「浏览...」重新选择。",
                    "目录无效", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            DialogResult confirm = MessageBox.Show(this,
                "将移除壁纸接入并把启动动画及 pet-hub\\index.js 还原到安装前版本。\r\n已保存的壁纸参数会保留，方便以后重新安装。\r\n\r\n是否继续？",
                "卸载 / 还原", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
            if (confirm != DialogResult.Yes) return;

            Cursor = Cursors.WaitCursor;
            _installButton.Enabled = false;
            _uninstallButton.Enabled = false;
            UninstallResult result = null;
            Exception error = null;
            using (WaitForm wait = new WaitForm("还原中", "正在准备…"))
            {
                Installer.Progress = delegate(string s) { wait.SetStatus(s); };
                Thread worker = new Thread(delegate()
                {
                    try { result = Installer.Uninstall(dir); }
                    catch (Exception ex) { error = ex; }
                    finally
                    {
                        Installer.Progress = null;
                        wait.MarkDone();
                    }
                });
                worker.IsBackground = true;
                worker.Start();
                wait.ShowDialog(this);
                worker.Join(3000);
            }
            _installButton.Enabled = true;
            _uninstallButton.Enabled = true;
            Cursor = Cursors.Default;

            if (error != null)
            {
                Log("还原失败：" + error.Message);
                MessageBox.Show(this, "还原失败：\r\n\r\n" + error.Message, "错误", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            Log("已还原 " + result.Restored + " 个文件，移除 " + result.Removed + " 个新增文件。");
            if (result.BackupDir != null) Log("使用的备份：" + result.BackupDir);

            MessageBox.Show(this,
                "还原完成！\r\n\r\n还原文件：" + result.Restored + " 个\r\n移除新增文件：" + result.Removed + " 个" +
                (result.BackupDir == null ? "" : "\r\n\r\n使用的备份：\r\n" + result.BackupDir) +
                "\r\n\r\n重启 M HUB 后生效。",
                "卸载 / 还原完成", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        private void Log(string message)
        {
            _logBox.AppendText("[" + DateTime.Now.ToString("HH:mm:ss") + "] " + message + "\r\n");
        }
    }
}
