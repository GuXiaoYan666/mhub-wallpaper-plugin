using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace MHubStartupPlugin
{
    internal static class Program
    {
        /* 2.0 版改名为 M HUB，但可执行文件仍叫 MCHOSE HUB.exe；
           同时兼容旧版 MCHOSE HUB 目录下同名 exe。候选数组支持以后版本改名。 */
        internal static readonly string[] ExeCandidates = new string[]
        {
            "MCHOSE HUB.exe",
            "M HUB.exe",
            "MCHOSE Hub.exe",
            "mchose-hub.exe"
        };
        /* 兼容代码里仍有 ExeName 直接引用；默认用第一个候选作为显示名。 */
        internal const string ExeName = "MCHOSE HUB.exe";

        internal static bool HasHubExe(string dir)
        {
            if (string.IsNullOrEmpty(dir)) return false;
            foreach (string name in ExeCandidates)
                if (File.Exists(Path.Combine(dir, name))) return true;
            return false;
        }
        internal static string FindHubExe(string dir)
        {
            if (string.IsNullOrEmpty(dir)) return null;
            foreach (string name in ExeCandidates)
            {
                string path = Path.Combine(dir, name);
                if (File.Exists(path)) return path;
            }
            return null;
        }

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
        internal const string AppEntryRel = @"resources\app\out\main\index.js";
        internal const string OfficialEntryRel = @"resources\app\out\main\index.official.js";
        internal const string BackupPrefix = "mhub-integration-backup-";
        internal const string PayloadResource = "payload.zip";
        internal const string OwnershipRel = @"resources\mhub-integration-owned.manifest";

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
                WriteLine("Hub exe     : " + (Program.HasHubExe(dir) ? "yes" : "no"));
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
                if (Program.HasHubExe(dir)) Installer.RestartHub(dir);
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

            /* 2.0 版改名为 M HUB，旧版仍叫 MCHOSE HUB；两边都加候选路径。 */
            Add(list, @"C:\Program Files\M HUB");
            Add(list, @"C:\Program Files (x86)\M HUB");
            Add(list, @"C:\Program Files\MCHOSE HUB");
            Add(list, @"C:\Program Files (x86)\MCHOSE HUB");
            Add(list, Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "M HUB"));
            Add(list, Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "M HUB"));
            Add(list, Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "MCHOSE HUB"));
            Add(list, Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "MCHOSE HUB"));

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
                if (Program.HasHubExe(dir)) return true;
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
        internal int Skipped;
    }

    internal sealed class InstallOptions
    {
        internal bool PetHub = true;
        internal bool LyricBridge = true;
        internal bool Sysdeck = true;

        internal bool Includes(string component)
        {
            if (component == "pet-hub") return PetHub;
            if (component == "lyric-bridge") return LyricBridge;
            if (component == "sysdeck") return Sysdeck;
            return true;
        }
    }

    internal sealed class PayloadEntry
    {
        internal string Component;
        internal string RelativePath;
        internal string TargetRelative;
        internal string Sha256;

        internal string TargetPath(string dir)
        {
            return Path.Combine(dir, TargetRelative);
        }
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

        /* 统一安装器一并部署的独立插件目录：代码各自独立，只共用加载入口。
           具体文件完全由 payload.zip 动态清单决定，避免更新时漏文件。 */
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
            return Install(dir, gui, new InstallOptions());
        }

        internal static InstallResult Install(string dir, bool gui, InstallOptions options)
        {
            dir = Program.NormalizePath(dir);
            if (!Check.IsValid(dir))
                throw new InvalidOperationException("M HUB 安装目录无效：" + (dir == null ? "(空)" : dir));
            if (options == null) options = new InstallOptions();
            LastNotice = null;

            Report("正在关闭 M HUB…");
            StopHub();
            string tempDir = Path.Combine(Path.GetTempPath(), "mhub-integration-payload-" + Guid.NewGuid().ToString("N"));
            string backupDir = null;
            ArchiveSnapshot archiveSnapshot = null;
            string ownershipSnapshot = null;
            int count = 0;
            try
            {
                Report("正在解压并校验内置文件…");
                List<PayloadEntry> allEntries = Payload.ExtractTo(tempDir);
                List<PayloadEntry> entries = new List<PayloadEntry>();
                foreach (PayloadEntry entry in allEntries)
                    if (options.Includes(entry.Component)) entries.Add(entry);

                Report("正在备份原有文件…");
                backupDir = Backup.Create(dir, Program.RendererPath(dir), entries);
                archiveSnapshot = ArchiveSnapshot.Capture(dir, tempDir);
                ownershipSnapshot = Ownership.Capture(dir, tempDir);

                Report("正在配置独立加载入口…");
                count += InstallBootstrap(dir, tempDir, entries);
                backupDir = RefreshBackupPath(dir, backupDir);

                Report("正在写入所选组件…");
                count += CopyEntries(tempDir, dir, entries, false);
                VerifyInstallation(dir, entries);
                Ownership.Write(dir, entries);
            }
            catch (Exception installError)
            {
                try
                {
                    Report("安装未完成，正在恢复到安装前状态…");
                    if (backupDir != null) backupDir = RefreshBackupPath(dir, backupDir);
                    if (backupDir != null) Backup.RestoreSingle(backupDir);
                    if (ownershipSnapshot != null) Ownership.Restore(dir, ownershipSnapshot);
                    if (archiveSnapshot != null) archiveSnapshot.Restore(dir);
                }
                catch (Exception rollbackError)
                {
                    throw new IOException("安装失败：" + installError.Message + "\r\n自动回滚也未完成：" + rollbackError.Message, installError);
                }
                throw;
            }
            finally
            {
                try { if (Directory.Exists(tempDir)) Directory.Delete(tempDir, true); }
                catch { }
            }

            if (gui && Program.HasHubExe(dir))
            {
                DialogResult answer = MessageBox.Show(
                    "增强组件已安装，原有壁纸参数、启动页配置和桌宠数据均已保留。\r\n\r\n是否立即重启 M HUB 以查看效果？",
                    "重启 M HUB", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
                if (answer == DialogResult.Yes) RestartHub(dir);
            }

            InstallResult result = new InstallResult();
            result.BackupDir = backupDir;
            result.FileCount = count;
            LastNotice = "官方归档保持原始字节；未选择的组件不会被卸载，桌宠配置与用户图集保持不变。";
            return result;
        }

        private static string RefreshBackupPath(string dir, string backupDir)
        {
            if (string.IsNullOrEmpty(backupDir)) return backupDir;
            string moved = Path.Combine(Program.BackupRoot(dir), Path.GetFileName(backupDir));
            return File.Exists(Path.Combine(moved, "manifest.txt")) ? moved : backupDir;
        }

        private static int CopyEntries(string payloadRoot, string dir, List<PayloadEntry> entries, bool bootstrap)
        {
            int count = 0;
            foreach (PayloadEntry entry in entries)
            {
                if ((entry.Component == "bootstrap") != bootstrap) continue;
                string source = Path.Combine(payloadRoot, entry.RelativePath);
                string target = entry.TargetPath(dir);
                if (!File.Exists(source)) throw new FileNotFoundException("内置 payload 缺少文件：" + entry.RelativePath, source);
                Directory.CreateDirectory(Path.GetDirectoryName(target));
                File.Copy(source, target, true);
                count++;
            }
            return count;
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

        private static bool HasBootstrapMarker(string file)
        {
            try
            {
                return File.ReadAllText(file).IndexOf(Program.BootstrapMarker, StringComparison.Ordinal) >= 0;
            }
            catch
            {
                return false;
            }
        }

        private static string ListArchives(string dir)
        {
            try
            {
                string resources = Path.Combine(dir, "resources");
                if (!Directory.Exists(resources)) return "(resources 目录不存在)";
                string[] files = Directory.GetFiles(resources, "*.asar");
                if (files.Length == 0) return "(无 .asar 文件)";
                string[] names = new string[files.Length];
                for (int i = 0; i < files.Length; i++) names[i] = Path.GetFileName(files[i]);
                return string.Join(", ", names);
            }
            catch
            {
                return "(读取失败)";
            }
        }

        private static int InstallBootstrap(string dir, string payloadRoot, List<PayloadEntry> entries)
        {
            string appDir = Path.Combine(dir, Program.AppRel);
            string asar = Path.Combine(dir, Program.AsarRel);
            string original = Path.Combine(dir, Program.OriginalAsarRel);
            string entry = Path.Combine(dir, Program.AppEntryRel);
            string officialEntry = Path.Combine(dir, Program.OfficialEntryRel);
            bool hasAsar = File.Exists(asar) || File.Exists(original);

            /* 部分官方安装没有 app.asar，入口直接是 resources\app\out\main\index.js。
               这种目录版安装先保留官方入口为 index.official.js，再写入本插件入口。 */
            if (!hasAsar)
            {
                if (File.Exists(entry) && !HasBootstrapMarker(entry))
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(officialEntry));
                    File.Copy(entry, officialEntry, true);
                }
                if (!File.Exists(officialEntry))
                    throw new InvalidOperationException(
                        "未找到 M HUB 官方入口：resources\\app.asar 与 resources\\app\\out\\main\\index.js 均不存在。\r\n" +
                        "请确认选择的是 M HUB 安装目录（例如 E:\\MCHOSE HUB），或先重新安装官方程序。\r\n" +
                        "当前 resources 中的归档：" + ListArchives(dir)
                    );
            }

            Directory.CreateDirectory(appDir);
            int count = CopyEntries(payloadRoot, dir, entries, true);
            if (count == 0) throw new InvalidOperationException("内置 payload 缺少独立加载入口。");

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

        private static void VerifyInstallation(string dir, List<PayloadEntry> entries)
        {
            string original = Path.Combine(dir, Program.OriginalAsarRel);
            string asar = Path.Combine(dir, Program.AsarRel);
            string officialEntry = Path.Combine(dir, Program.OfficialEntryRel);
            string bootstrap = Path.Combine(dir, Program.AppEntryRel);
            string renderer = Program.RendererPath(dir);
            bool hasAsar = File.Exists(original) || File.Exists(asar);
            if (!hasAsar && !File.Exists(officialEntry))
                throw new IOException("安装校验失败：官方入口备份不存在。");
            if (File.Exists(asar)) throw new IOException("安装校验失败：app.asar 仍占用入口，请关闭 M HUB 后重试。");
            if (!File.Exists(bootstrap) || File.ReadAllText(bootstrap).IndexOf(Program.BootstrapMarker, StringComparison.Ordinal) < 0)
                throw new IOException("安装校验失败：独立加载入口未正确写入。");

            foreach (PayloadEntry entry in entries)
            {
                string installed = entry.TargetPath(dir);
                if (!File.Exists(installed))
                    throw new IOException("安装校验失败：文件未写入（" + entry.TargetRelative + "）。");
                string actual = Payload.Sha256File(installed);
                if (!string.Equals(actual, entry.Sha256, StringComparison.OrdinalIgnoreCase))
                    throw new IOException("安装校验失败：SHA256 不匹配（" + entry.TargetRelative + "）。");
            }

            if (renderer != null && !File.Exists(Path.Combine(renderer, "startup-loading.html")))
                throw new IOException("安装校验失败：官方启动页缺失，无法挂载启动动画。");
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

            /* 目录版安装：把保留的官方入口放回原位。 */
            string entry = Path.Combine(dir, Program.AppEntryRel);
            string officialEntry = Path.Combine(dir, Program.OfficialEntryRel);
            if (File.Exists(officialEntry))
            {
                if (File.Exists(entry) && HasBootstrapMarker(entry)) File.Delete(entry);
                if (!File.Exists(entry)) File.Move(officialEntry, entry);
                else File.Delete(officialEntry);
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
            bool hadOriginalArchive = File.Exists(Path.Combine(dir, Program.OriginalAsarRel));
            Report("正在关闭 M HUB…");
            StopHub();

            UninstallResult result = new UninstallResult();
            result.BackupDir = FindLatestBackup(backupRoot);
            Dictionary<string, string> owned = Ownership.Read(dir);
            Dictionary<string, string> restores = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            HashSet<string> deletes = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            List<string> usedBackups = new List<string>();

            /* 每个目标以最早备份记录为准：原本不存在的文件，不能因为后续升级
               又备份了旧插件版本而被错误还原。 */
            foreach (string oneBackup in ListBackupsOldestFirst(backupRoot))
            {
                string manifest = Path.Combine(oneBackup, "manifest.txt");
                if (!File.Exists(manifest)) continue;
                usedBackups.Add(oneBackup);
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
                        if (!seen.Add(absolute)) continue;
                        string source = Path.Combine(oneBackup, body.Substring(bar + 1));
                        if (File.Exists(source)) restores[absolute] = source;
                    }
                    else if (line.StartsWith("add=", StringComparison.OrdinalIgnoreCase))
                    {
                        string absolute = NormalizeBackupPath(line.Substring(4), recordedRenderer, renderer);
                        if (seen.Add(absolute)) deletes.Add(absolute);
                    }
                }
            }

            foreach (KeyValuePair<string, string> item in owned)
                if (!seen.Contains(item.Key) && IsManagedPath(dir, item.Key)) deletes.Add(item.Key);

            foreach (KeyValuePair<string, string> item in restores)
            {
                if (!IsManagedPath(dir, item.Key)) { result.Skipped++; continue; }
                if (File.Exists(item.Key) && owned.ContainsKey(Path.GetFullPath(item.Key)) &&
                    !Ownership.IsOwned(owned, item.Key, Payload.Sha256File(item.Key)))
                {
                    result.Skipped++;
                    continue;
                }
                Directory.CreateDirectory(Path.GetDirectoryName(item.Key));
                File.Copy(item.Value, item.Key, true);
                result.Restored++;
            }

            foreach (string absolute in deletes)
            {
                if (!File.Exists(absolute) || !IsManagedPath(dir, absolute)) continue;
                if (owned.ContainsKey(Path.GetFullPath(absolute)) &&
                    !Ownership.IsOwned(owned, absolute, Payload.Sha256File(absolute)))
                {
                    result.Skipped++;
                    continue;
                }
                File.Delete(absolute);
                result.Removed++;
            }

            string legacyBootstrap = Path.Combine(dir, Program.AppRel, "mhub-wallpaper-bootstrap.js");
            if (File.Exists(legacyBootstrap))
            {
                try
                {
                    if (File.ReadAllText(legacyBootstrap).IndexOf(Program.BootstrapMarker, StringComparison.Ordinal) >= 0)
                    {
                        File.Delete(legacyBootstrap);
                        result.Removed++;
                    }
                }
                catch { }
            }

            /* 仅兼容旧版 shim 的还原；完整 pet-hub 不再生成或串联 index.original.js。 */
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
                try { if (Directory.Exists(oneBackup)) Directory.Delete(oneBackup, true); }
                catch { }
            }
            RemoveEmptyDirectory(backupRoot);
            RestoreArchive(dir);
            if (hadOriginalArchive) result.Restored++;

            string ownershipFile = Path.Combine(dir, Program.OwnershipRel);
            if (File.Exists(ownershipFile)) File.Delete(ownershipFile);
            RemoveEmptyDirectories(wallpaper);
            RemoveEmptyDirectories(pethub);
            foreach (string plugin in PluginDirs)
                RemoveEmptyDirectories(Path.Combine(dir, Program.AppRel, plugin));
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

        private static void RemoveEmptyDirectories(string dir)
        {
            try
            {
                if (!Directory.Exists(dir)) return;
                foreach (string child in Directory.GetDirectories(dir)) RemoveEmptyDirectories(child);
                RemoveEmptyDirectory(dir);
            }
            catch { }
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

        private static bool IsManagedPath(string dir, string absolute)
        {
            string full;
            try { full = Path.GetFullPath(absolute); }
            catch { return false; }
            if (string.Equals(full, Path.Combine(dir, Program.AppRel, "package.json"), StringComparison.OrdinalIgnoreCase) ||
                string.Equals(full, Path.Combine(dir, Program.AppEntryRel), StringComparison.OrdinalIgnoreCase) ||
                string.Equals(full, Path.Combine(dir, Program.OfficialEntryRel), StringComparison.OrdinalIgnoreCase) ||
                string.Equals(full, Path.Combine(dir, Program.AppRel, "mhub-wallpaper-bootstrap.js"), StringComparison.OrdinalIgnoreCase))
                return true;

            if (IsUnder(full, Path.Combine(dir, Program.WallpaperRel)) ||
                IsUnder(full, Path.Combine(dir, Program.PetHubRel))) return true;
            foreach (string plugin in PluginDirs)
                if (IsUnder(full, Path.Combine(dir, Program.AppRel, plugin))) return true;
            return false;
        }

        private static bool IsUnder(string path, string root)
        {
            string prefix = Path.GetFullPath(root).TrimEnd('\\') + "\\";
            return path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase);
        }

        private static void StopHub()
        {
            /* 2.0 版目录叫 M HUB 但进程仍叫 MCHOSE HUB；同时 kill 两边进程名，
               一次结束所有同名进程再统一限时等待，避免逐个进程串行等待卡一分多钟。 */
            string[] processNames = new string[]
            {
                "MCHOSE HUB",
                "M HUB",
                "MCHOSE HUB Launcher",
                "M HUB Launcher",
                "MCHOSE HUB Watcher",
                "M HUB Watcher"
            };
            bool stopped = false;
            for (int round = 0; round < 3; round++)
            {
                List<Process> all = new List<Process>();
                foreach (string name in processNames)
                {
                    try { all.AddRange(Process.GetProcessesByName(name)); } catch { }
                }
                if (all.Count == 0) break;
                stopped = true;
                foreach (Process process in all)
                {
                    try { process.Kill(); }
                    catch { }
                }
                DateTime deadline = DateTime.UtcNow.AddMilliseconds(1500);
                foreach (Process process in all)
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
            string exe = Program.FindHubExe(dir);
            if (string.IsNullOrEmpty(exe)) return;
            try
            {
                ProcessStartInfo info = new ProcessStartInfo(exe);
                info.WorkingDirectory = dir;
                info.UseShellExecute = true;
                Process.Start(info);
            }
            catch { }
        }
    }

    internal static class Backup
    {
        internal static string Create(string dir, string renderer, List<PayloadEntry> entries)
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
            lines.Add("# M HUB dynamic component backup v4.0");
            lines.Add("created=" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"));
            lines.Add("renderer=" + (renderer ?? string.Empty));
            lines.Add("originalAsar=" + Path.Combine(dir, Program.OriginalAsarRel));
            Dictionary<string, string> owned = Ownership.Read(dir);

            foreach (PayloadEntry entry in entries)
            {
                string source = entry.TargetPath(dir);
                string backupRel = Path.Combine("files", Path.Combine(entry.Component, entry.RelativePath));
                if (!File.Exists(source))
                {
                    lines.Add("add=" + source);
                    continue;
                }

                string currentHash = Payload.Sha256File(source);
                bool isCurrentPayload = string.Equals(currentHash, entry.Sha256, StringComparison.OrdinalIgnoreCase);
                bool isLegacyShim = false;
                if (string.Equals(source, Path.Combine(dir, Program.PetHubRel, "index.js"), StringComparison.OrdinalIgnoreCase))
                {
                    try { isLegacyShim = File.ReadAllText(source).IndexOf(Program.ShimMarker, StringComparison.Ordinal) >= 0; }
                    catch { }
                }
                if (isCurrentPayload || isLegacyShim || Ownership.IsOwned(owned, source, currentHash))
                {
                    lines.Add("add=" + source);
                    continue;
                }

                CopyInto(backupDir, backupRel, source);
                lines.Add("file=" + source + "|" + backupRel);
            }

            File.WriteAllText(
                Path.Combine(backupDir, "manifest.txt"),
                string.Join("\r\n", lines.ToArray()) + "\r\n",
                new UTF8Encoding(true));
            return backupDir;
        }

        internal static void RestoreSingle(string backupDir)
        {
            string manifest = Path.Combine(backupDir, "manifest.txt");
            if (!File.Exists(manifest)) return;
            foreach (string rawLine in File.ReadAllLines(manifest, Encoding.UTF8))
            {
                string line = rawLine.Trim();
                if (line.StartsWith("file=", StringComparison.OrdinalIgnoreCase))
                {
                    string body = line.Substring(5);
                    int bar = body.LastIndexOf('|');
                    if (bar <= 0) continue;
                    string target = body.Substring(0, bar);
                    string source = Path.Combine(backupDir, body.Substring(bar + 1));
                    if (!File.Exists(source)) throw new FileNotFoundException("回滚备份缺失。", source);
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    File.Copy(source, target, true);
                }
                else if (line.StartsWith("add=", StringComparison.OrdinalIgnoreCase))
                {
                    string target = line.Substring(4);
                    if (File.Exists(target)) File.Delete(target);
                }
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
        internal static List<PayloadEntry> ExtractTo(string destination)
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
            string destinationRoot = Path.GetFullPath(destination).TrimEnd('\\') + "\\";
            List<PayloadEntry> files = new List<PayloadEntry>();
            HashSet<string> targets = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            using (stream)
            using (ZipArchive archive = new ZipArchive(stream, ZipArchiveMode.Read))
            {
                foreach (ZipArchiveEntry zipEntry in archive.Entries)
                {
                    string name = zipEntry.FullName.Replace('/', '\\');
                    if (name.EndsWith("\\")) continue;
                    if (name.Length == 0 || Path.IsPathRooted(name) || name.StartsWith("\\", StringComparison.Ordinal))
                        throw new InvalidDataException("payload 包含非法路径：" + name);
                    string[] segments = name.Split('\\');
                    foreach (string segment in segments)
                        if (segment.Length == 0 || segment == "." || segment == ".." || segment.IndexOf(':') >= 0)
                            throw new InvalidDataException("payload 包含非法路径：" + name);

                    string target = Path.GetFullPath(Path.Combine(destination, name));
                    if (!target.StartsWith(destinationRoot, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidDataException("payload 路径超出解压目录：" + name);
                    PayloadEntry item = CreateEntry(name);
                    if (!targets.Add(item.TargetRelative))
                        throw new InvalidDataException("payload 包含重复目标：" + item.TargetRelative);

                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    using (Stream input = zipEntry.Open())
                    using (FileStream output = File.Create(target))
                    {
                        input.CopyTo(output);
                    }
                    item.Sha256 = Sha256File(target);
                    files.Add(item);
                }
            }
            return files;
        }

        private static PayloadEntry CreateEntry(string name)
        {
            int slash = name.IndexOf('\\');
            if (slash <= 0 || slash == name.Length - 1)
                throw new InvalidDataException("payload 文件必须位于组件目录中：" + name);
            string component = name.Substring(0, slash);
            string relative = name.Substring(slash + 1);
            string targetRelative;
            if (component == "bootstrap")
                targetRelative = Path.Combine(Program.AppRel, relative);
            else if (component == "renderer")
                targetRelative = Path.Combine(Path.Combine(Program.WallpaperRel, "splash"), relative);
            else if (component == "wallpaper-hub" || component == "pet-hub" || component == "lyric-bridge" || component == "sysdeck")
                targetRelative = Path.Combine(Program.AppRel, name);
            else
                throw new InvalidDataException("payload 包含未知组件：" + component);

            PayloadEntry item = new PayloadEntry();
            item.Component = component;
            item.RelativePath = name;
            item.TargetRelative = targetRelative;
            return item;
        }

        internal static string Sha256File(string file)
        {
            using (FileStream stream = File.OpenRead(file))
            using (SHA256 sha = SHA256.Create())
            {
                return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", string.Empty);
            }
        }
    }

    internal static class Ownership
    {
        internal static Dictionary<string, string> Read(string dir)
        {
            Dictionary<string, string> result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            string file = Path.Combine(dir, Program.OwnershipRel);
            if (!File.Exists(file)) return result;
            foreach (string rawLine in File.ReadAllLines(file, Encoding.UTF8))
            {
                string line = rawLine.Trim();
                if (!line.StartsWith("file=", StringComparison.OrdinalIgnoreCase)) continue;
                string body = line.Substring(5);
                int bar = body.LastIndexOf('|');
                if (bar <= 0 || bar == body.Length - 1) continue;
                string path = body.Substring(0, bar);
                if (!Path.IsPathRooted(path)) path = Path.Combine(dir, path);
                try { path = Path.GetFullPath(path); }
                catch { continue; }
                result[path] = body.Substring(bar + 1).Trim();
            }
            return result;
        }

        internal static bool IsOwned(Dictionary<string, string> owned, string path, string currentHash)
        {
            string full = Path.GetFullPath(path);
            string expected;
            return owned.TryGetValue(full, out expected) &&
                string.Equals(expected, currentHash, StringComparison.OrdinalIgnoreCase);
        }

        internal static string Capture(string dir, string tempDir)
        {
            string snapshot = Path.Combine(tempDir, "ownership.previous");
            string source = Path.Combine(dir, Program.OwnershipRel);
            if (File.Exists(source)) File.Copy(source, snapshot, true);
            else File.WriteAllText(snapshot, string.Empty, Encoding.UTF8);
            return snapshot;
        }

        internal static void Restore(string dir, string snapshot)
        {
            string target = Path.Combine(dir, Program.OwnershipRel);
            if (new FileInfo(snapshot).Length == 0)
            {
                if (File.Exists(target)) File.Delete(target);
                return;
            }
            Directory.CreateDirectory(Path.GetDirectoryName(target));
            File.Copy(snapshot, target, true);
        }

        internal static void Write(string dir, List<PayloadEntry> entries)
        {
            Dictionary<string, string> merged = Read(dir);
            foreach (PayloadEntry entry in entries)
                merged[Path.GetFullPath(entry.TargetPath(dir))] = entry.Sha256;

            List<string> paths = new List<string>(merged.Keys);
            paths.Sort(StringComparer.OrdinalIgnoreCase);
            List<string> lines = new List<string>();
            lines.Add("# M HUB installer-owned files; path|SHA256");
            string root = Path.GetFullPath(dir).TrimEnd('\\') + "\\";
            foreach (string path in paths)
            {
                string relative = path.StartsWith(root, StringComparison.OrdinalIgnoreCase) ? path.Substring(root.Length) : path;
                lines.Add("file=" + relative + "|" + merged[path]);
            }
            string target = Path.Combine(dir, Program.OwnershipRel);
            Directory.CreateDirectory(Path.GetDirectoryName(target));
            string staging = target + ".new";
            File.WriteAllText(staging, string.Join("\r\n", lines.ToArray()) + "\r\n", new UTF8Encoding(false));
            File.Copy(staging, target, true);
            File.Delete(staging);
        }
    }

    internal sealed class ArchiveSnapshot
    {
        private string _root;
        private bool _hadAsar;
        private bool _hadOriginal;
        private bool _hadUnpacked;
        private bool _hadOriginalUnpacked;
        private bool _hadOfficialEntry;

        internal static ArchiveSnapshot Capture(string dir, string tempDir)
        {
            ArchiveSnapshot snapshot = new ArchiveSnapshot();
            snapshot._root = Path.Combine(tempDir, "archive-state");
            Directory.CreateDirectory(snapshot._root);
            string asar = Path.Combine(dir, Program.AsarRel);
            string original = Path.Combine(dir, Program.OriginalAsarRel);
            string unpacked = Path.Combine(dir, Program.UnpackedRel);
            string originalUnpacked = Path.Combine(dir, Program.OriginalUnpackedRel);
            string officialEntry = Path.Combine(dir, Program.OfficialEntryRel);
            snapshot._hadAsar = File.Exists(asar);
            snapshot._hadOriginal = File.Exists(original);
            snapshot._hadUnpacked = Directory.Exists(unpacked);
            snapshot._hadOriginalUnpacked = Directory.Exists(originalUnpacked);
            snapshot._hadOfficialEntry = File.Exists(officialEntry);

            if (snapshot._hadAsar && snapshot._hadOriginal)
            {
                File.Copy(asar, Path.Combine(snapshot._root, "app.asar"), true);
                File.Copy(original, Path.Combine(snapshot._root, "original.asar"), true);
            }
            if (snapshot._hadUnpacked && snapshot._hadOriginalUnpacked)
            {
                CopyDirectory(unpacked, Path.Combine(snapshot._root, "unpacked"));
                CopyDirectory(originalUnpacked, Path.Combine(snapshot._root, "original-unpacked"));
            }
            if (snapshot._hadOfficialEntry)
                File.Copy(officialEntry, Path.Combine(snapshot._root, "index.official.js"), true);
            return snapshot;
        }

        internal void Restore(string dir)
        {
            string asar = Path.Combine(dir, Program.AsarRel);
            string original = Path.Combine(dir, Program.OriginalAsarRel);
            string unpacked = Path.Combine(dir, Program.UnpackedRel);
            string originalUnpacked = Path.Combine(dir, Program.OriginalUnpackedRel);
            string officialEntry = Path.Combine(dir, Program.OfficialEntryRel);

            if (_hadAsar && _hadOriginal)
            {
                File.Copy(Path.Combine(_root, "app.asar"), asar, true);
                File.Copy(Path.Combine(_root, "original.asar"), original, true);
            }
            else if (_hadAsar && !_hadOriginal && File.Exists(original))
            {
                if (File.Exists(asar)) File.Delete(original);
                else File.Move(original, asar);
            }

            if (_hadUnpacked && _hadOriginalUnpacked)
            {
                RestoreDirectory(Path.Combine(_root, "unpacked"), unpacked);
                RestoreDirectory(Path.Combine(_root, "original-unpacked"), originalUnpacked);
            }
            else if (_hadUnpacked && !_hadOriginalUnpacked && Directory.Exists(originalUnpacked))
            {
                if (Directory.Exists(unpacked)) Directory.Delete(originalUnpacked, true);
                else Directory.Move(originalUnpacked, unpacked);
            }

            if (_hadOfficialEntry)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(officialEntry));
                File.Copy(Path.Combine(_root, "index.official.js"), officialEntry, true);
            }
            else if (File.Exists(officialEntry))
            {
                File.Delete(officialEntry);
            }
        }

        private static void RestoreDirectory(string source, string target)
        {
            if (Directory.Exists(target)) Directory.Delete(target, true);
            CopyDirectory(source, target);
        }

        private static void CopyDirectory(string source, string target)
        {
            Directory.CreateDirectory(target);
            foreach (string file in Directory.GetFiles(source))
                File.Copy(file, Path.Combine(target, Path.GetFileName(file)), true);
            foreach (string child in Directory.GetDirectories(source))
                CopyDirectory(child, Path.Combine(target, Path.GetFileName(child)));
        }
    }

}
