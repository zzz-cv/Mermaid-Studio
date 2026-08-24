using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace MermaidStudio
{
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            if (args.Any(arg => string.Equals(arg, "--logic-test", StringComparison.OrdinalIgnoreCase)))
            {
                Environment.ExitCode = MainForm.RunLogicTest();
                return;
            }
            int folderTestIndex = Array.FindIndex(args, arg => string.Equals(arg, "--folder-test", StringComparison.OrdinalIgnoreCase));
            if (folderTestIndex >= 0)
            {
                Environment.ExitCode = folderTestIndex + 1 < args.Length ? MainForm.RunFolderTest(args[folderTestIndex + 1]) : 29;
                return;
            }
            int pngTestIndex = Array.FindIndex(args, arg => string.Equals(arg, "--png-test", StringComparison.OrdinalIgnoreCase));
            string pngTestOutput = pngTestIndex >= 0 && pngTestIndex + 1 < args.Length ? args[pngTestIndex + 1] : null;
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm(args.Any(arg => string.Equals(arg, "--smoke-test", StringComparison.OrdinalIgnoreCase)) || pngTestOutput != null, pngTestOutput));
        }
    }

    internal sealed class MainForm : Form
    {
        private static readonly HashSet<string> SkippedDirectories = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            ".git", "node_modules", "dist", "release", ".next", ".vinext", ".wrangler"
        };

        private readonly WebView2 webView = new WebView2();
        private readonly JavaScriptSerializer serializer = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        private readonly List<string> workspaceRoots = new List<string>();
        private readonly Dictionary<string, FileSystemWatcher> watchers = new Dictionary<string, FileSystemWatcher>(StringComparer.OrdinalIgnoreCase);
        private readonly Timer refreshTimer = new Timer { Interval = 160 };
        private readonly Timer smokeTimeout = new Timer { Interval = 20000 };
        private bool refreshRunning;
        private bool refreshQueued;
        private readonly bool smokeTest;
        private readonly string pngTestOutput;
        private static readonly string LogDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Mermaid Studio", "logs");
        private static readonly string LogPath = Path.Combine(LogDirectory, "latest.log");

        public MainForm(bool smokeTest = false, string pngTestOutput = null)
        {
            this.smokeTest = smokeTest;
            this.pngTestOutput = pngTestOutput;
            Text = "Mermaid Studio";
            ShowIcon = true;
            using (Icon executableIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath))
            {
                if (executableIcon != null) Icon = (Icon)executableIcon.Clone();
            }
            MinimumSize = new Size(880, 600);
            StartPosition = FormStartPosition.Manual;
            Bounds = InitialWindowBounds(Screen.FromPoint(Cursor.Position).WorkingArea);
            BackColor = Color.FromArgb(237, 241, 238);
            AutoScaleMode = AutoScaleMode.Dpi;
            if (smokeTest)
            {
                ShowInTaskbar = false;
                Opacity = 0.01;
            }
            webView.Dock = DockStyle.Fill;
            Controls.Add(webView);
            refreshTimer.Tick += async (_, __) =>
            {
                refreshTimer.Stop();
                await BroadcastWorkspaceSnapshotAsync();
            };
            Shown += async (_, __) => await InitializeWebViewAsync();
            FormClosed += (_, __) => { smokeTimeout.Stop(); smokeTimeout.Dispose(); DisposeWatchers(); };
        }

        protected override void OnHandleCreated(EventArgs eventArgs)
        {
            base.OnHandleCreated(eventArgs);
            ApplyLegacyWindowFrame();
        }

        private void ApplyLegacyWindowFrame()
        {
            if (Environment.OSVersion.Version.Major < 10) return;
            try
            {
                int lightMode = 0;
                NativeMethods.DwmSetWindowAttribute(Handle, NativeMethods.DWMWA_USE_IMMERSIVE_DARK_MODE, ref lightMode, sizeof(int));

                int roundedCorners = NativeMethods.DWMWCP_ROUND;
                NativeMethods.DwmSetWindowAttribute(Handle, NativeMethods.DWMWA_WINDOW_CORNER_PREFERENCE, ref roundedCorners, sizeof(int));

                int borderColor = ColorTranslator.ToWin32(Color.FromArgb(220, 225, 222));
                NativeMethods.DwmSetWindowAttribute(Handle, NativeMethods.DWMWA_BORDER_COLOR, ref borderColor, sizeof(int));

                int captionColor = ColorTranslator.ToWin32(Color.FromArgb(248, 249, 248));
                NativeMethods.DwmSetWindowAttribute(Handle, NativeMethods.DWMWA_CAPTION_COLOR, ref captionColor, sizeof(int));

                int textColor = ColorTranslator.ToWin32(Color.FromArgb(30, 36, 32));
                NativeMethods.DwmSetWindowAttribute(Handle, NativeMethods.DWMWA_TEXT_COLOR, ref textColor, sizeof(int));
                NativeMethods.SetWindowTheme(Handle, "Explorer", null);
            }
            catch (DllNotFoundException) { }
            catch (EntryPointNotFoundException) { }
        }

        private static class NativeMethods
        {
            internal const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
            internal const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
            internal const int DWMWA_BORDER_COLOR = 34;
            internal const int DWMWA_CAPTION_COLOR = 35;
            internal const int DWMWA_TEXT_COLOR = 36;
            internal const int DWMWCP_ROUND = 2;

            [DllImport("dwmapi.dll")]
            internal static extern int DwmSetWindowAttribute(IntPtr windowHandle, int attribute, ref int value, int valueSize);

            [DllImport("uxtheme.dll", CharSet = CharSet.Unicode)]
            internal static extern int SetWindowTheme(IntPtr windowHandle, string subAppName, string subIdList);
        }

        internal static int RunLogicTest()
        {
            string testRoot = Path.Combine(Path.GetTempPath(), "mermaid-studio-light-test-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(testRoot);
            try
            {
                Directory.CreateDirectory(Path.Combine(testRoot, "empty-folder", "nested"));
                File.WriteAllText(Path.Combine(testRoot, "empty-folder", "notes.txt"), "not markdown");
                string markdownDirectory = Path.Combine(testRoot, "with-markdown", "nested");
                Directory.CreateDirectory(markdownDirectory);
                File.WriteAllText(Path.Combine(markdownDirectory, "nested-diagram.md"), "flowchart LR\n  A --> B");
                using (MainForm form = new MainForm(true))
                {
                    form.AddWorkspaceRoot(testRoot);
                    Dictionary<string, object> parsed = form.serializer.Deserialize<Dictionary<string, object>>("{\"kind\":\"request\",\"id\":1,\"method\":\"workspace:refresh\",\"args\":[]}");
                    object[] parsedArgs = NormalizeArguments(parsed["args"]);
                    if (parsedArgs.Length != 0) return 10;
                    Dictionary<string, object> dispatched = (Dictionary<string, object>)form.HandleRequestAsync(Convert.ToString(parsed["method"]), parsedArgs).GetAwaiter().GetResult();
                    object[] dispatchedFolders = (object[])dispatched["folders"];
                    if (dispatchedFolders.Length != 1) return 15;
                    List<Dictionary<string, object>> initialTree = new List<Dictionary<string, object>>();
                    CollectTreeEntries((object[])((Dictionary<string, object>)dispatchedFolders[0])["tree"], initialTree);
                    if (initialTree.Any(item => Convert.ToString(item["name"]) == "empty-folder")) return 20;
                    if (initialTree.Any(item => Convert.ToString(item["kind"]) == "file" && !Convert.ToString(item["name"]).EndsWith(".md", StringComparison.OrdinalIgnoreCase))) return 20;
                    if (!initialTree.Any(item => Convert.ToString(item["name"]) == "nested-diagram.md")) return 20;
                    object saved = form.SaveDraft("untitled-flowchart.md", "%% type: flowchart\nflowchart LR\n  A --> B", testRoot);
                    Dictionary<string, object> result = (Dictionary<string, object>)saved;
                    string filePath = Convert.ToString(result["filePath"]);
                    if (!File.Exists(filePath)) return 11;
                    Dictionary<string, object> snapshot = (Dictionary<string, object>)result["snapshot"];
                    if (((object[])snapshot["recognized"]).Length != 1) return 12;
                    try
                    {
                        form.SaveDraft("untitled-flowchart.md", "duplicate", testRoot);
                        return 18;
                    }
                    catch (IOException error)
                    {
                        if (!error.Message.Contains("同名文件")) return 18;
                    }
                    form.SaveFile(filePath, "%% type: sequence\nsequenceDiagram\n  A->>B: test");
                    Dictionary<string, object> afterSave = (Dictionary<string, object>)form.WorkspaceSnapshot();
                    if (((object[])afterSave["recognized"]).Length != 1) return 13;
                    Dictionary<string, object> renamed = (Dictionary<string, object>)form.RenameFile(filePath, "renamed-diagram");
                    filePath = Convert.ToString(renamed["filePath"]);
                    if (!filePath.EndsWith("renamed-diagram.md", StringComparison.OrdinalIgnoreCase) || !File.Exists(filePath)) return 17;
                    form.DeleteFile(filePath);
                    if (File.Exists(filePath)) return 14;
                    Rectangle initialBounds = InitialWindowBounds(new Rectangle(0, 0, 1920, 1040));
                    if (initialBounds.Width != 1536 || initialBounds.Height != 832 || initialBounds.X != 192 || initialBounds.Y != 104) return 16;
                    return 0;
                }
            }
            catch { return 19; }
            finally
            {
                try { Directory.Delete(testRoot, true); } catch { }
            }
        }

        private static void CollectTreeEntries(object[] nodes, List<Dictionary<string, object>> entries)
        {
            foreach (object nodeValue in nodes)
            {
                Dictionary<string, object> node = (Dictionary<string, object>)nodeValue;
                entries.Add(node);
                if (Convert.ToString(node["kind"]) == "directory") CollectTreeEntries((object[])node["children"], entries);
            }
        }

        internal static int RunFolderTest(string rootPath)
        {
            try
            {
                using (MainForm form = new MainForm(true))
                {
                    form.AddWorkspaceRoot(rootPath);
                    Dictionary<string, object> snapshot = (Dictionary<string, object>)form.HandleRequestAsync("workspace:refresh", new object[0]).GetAwaiter().GetResult();
                    object[] folders = (object[])snapshot["folders"];
                    return folders.Length == 1 ? 0 : 21;
                }
            }
            catch (Exception error)
            {
                LogError("folder-test", error);
                return 22;
            }
        }

        private async Task InitializeWebViewAsync()
        {
            if (smokeTest)
            {
                smokeTimeout.Tick += (_, __) => { smokeTimeout.Stop(); Environment.ExitCode = 2; Close(); };
                smokeTimeout.Start();
            }
            try
            {
                string baseDirectory = AppDomain.CurrentDomain.BaseDirectory;
                string distDirectory = Path.Combine(baseDirectory, "dist");
                string bridgePath = Path.Combine(baseDirectory, "bridge.js");
                if (!Directory.Exists(distDirectory) || !File.Exists(bridgePath))
                    throw new FileNotFoundException("应用资源不完整，请重新解压 Mermaid Studio。\n缺少 dist 或 bridge.js。", bridgePath);

                string userData = smokeTest
                    ? Path.Combine(Path.GetTempPath(), "Mermaid-Studio-Smoke-" + Process.GetCurrentProcess().Id)
                    : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Mermaid Studio", "WebView2");
                CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(null, userData);
                await webView.EnsureCoreWebView2Async(environment);
                webView.CoreWebView2.Settings.AreDevToolsEnabled = false;
                webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
                webView.CoreWebView2.SetVirtualHostNameToFolderMapping("appassets.local", distDirectory, CoreWebView2HostResourceAccessKind.DenyCors);
                await webView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(File.ReadAllText(bridgePath, Encoding.UTF8));
                webView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;
                if (smokeTest)
                {
                    webView.CoreWebView2.NavigationCompleted += async (_, args) =>
                    {
                        if (!args.IsSuccess) { Environment.ExitCode = 3; Close(); return; }
                        if (pngTestOutput != null)
                        {
                            try
                            {
                                string testSvg = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"640\" height=\"360\" viewBox=\"0 0 640 360\"><rect width=\"640\" height=\"360\" fill=\"#f5faf7\"/><foreignObject x=\"90\" y=\"120\" width=\"460\" height=\"120\"><div xmlns=\"http://www.w3.org/1999/xhtml\" style=\"font:32px 'Microsoft YaHei';color:#244a3b;text-align:center;padding:28px\">Mermaid Studio 中文 HTML 标签</div></foreignObject></svg>";
                                await RenderSvgToPngAsync(testSvg, 1280, 720, pngTestOutput);
                                using (Image image = Image.FromFile(pngTestOutput))
                                {
                                    if (image.Width <= 0 || image.Height <= 0) throw new InvalidOperationException("PNG 自检输出尺寸无效");
                                }
                                smokeTimeout.Stop();
                                Environment.ExitCode = 0;
                            }
                            catch (Exception error)
                            {
                                LogError("png-test", error);
                                Environment.ExitCode = 6;
                            }
                            Close();
                            return;
                        }
                        string title = await webView.CoreWebView2.ExecuteScriptAsync("document.querySelector('strong')?.textContent || ''");
                        smokeTimeout.Stop();
                        Environment.ExitCode = title.Contains("Mermaid Studio") ? 0 : 4;
                        Close();
                    };
                }
                webView.CoreWebView2.NavigationStarting += (_, args) =>
                {
                    if (args.Uri.StartsWith("https://appassets.local/", StringComparison.OrdinalIgnoreCase)) return;
                    args.Cancel = true;
                    if (Uri.TryCreate(args.Uri, UriKind.Absolute, out Uri uri) && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps))
                        Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
                };
                webView.Source = new Uri("https://appassets.local/index.html");
            }
            catch (Exception error)
            {
                LogError("initialize", error);
                if (smokeTest)
                {
                    try { File.WriteAllText(Path.Combine(Path.GetTempPath(), "mermaid-studio-smoke-error.txt"), error.ToString()); } catch { }
                    Environment.ExitCode = 5;
                    Close();
                    return;
                }
                MessageBox.Show(this, "无法启动轻量版 Mermaid Studio。\n\n" + error.Message + "\n\n请确认已安装 Microsoft Edge WebView2 Runtime。", "启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close();
            }
        }

        private async void OnWebMessageReceived(object sender, CoreWebView2WebMessageReceivedEventArgs eventArgs)
        {
            Dictionary<string, object> request;
            try
            {
                request = serializer.Deserialize<Dictionary<string, object>>(eventArgs.WebMessageAsJson);
                if (!request.TryGetValue("kind", out object kind) || Convert.ToString(kind) != "request") return;
            }
            catch (Exception error)
            {
                LogError("bridge:parse", error);
                return;
            }

            object id = request["id"];
            try
            {
                string method = Convert.ToString(request["method"]);
                object[] args = request.TryGetValue("args", out object rawArgs) ? NormalizeArguments(rawArgs) : new object[0];
                object result = await HandleRequestAsync(method, args);
                PostJson(new Dictionary<string, object> { ["kind"] = "response", ["id"] = id, ["ok"] = true, ["result"] = result });
            }
            catch (Exception error)
            {
                LogError("bridge:" + Convert.ToString(request.ContainsKey("method") ? request["method"] : "unknown"), error);
                PostJson(new Dictionary<string, object> { ["kind"] = "response", ["id"] = id, ["ok"] = false, ["error"] = error.GetBaseException().Message });
            }
        }

        private async Task<object> HandleRequestAsync(string method, object[] args)
        {
            switch (method)
            {
                case "workspace:open": return OpenWorkspace();
                case "workspace:refresh": return WorkspaceSnapshot();
                case "workspace:remove": return RemoveWorkspace(Arg(args, 0));
                case "file:read": return ReadFile(Arg(args, 0));
                case "file:save": return SaveFile(Arg(args, 0), Arg(args, 1));
                case "file:rename": return RenameFile(Arg(args, 0), Arg(args, 1));
                case "file:create": return CreateFile(Arg(args, 0), Arg(args, 1), Arg(args, 2));
                case "file:delete": return DeleteFile(Arg(args, 0));
                case "file:saveAs": return SaveDraft(Arg(args, 0), Arg(args, 1), ArgOrNull(args, 2));
                case "file:export": return ExportFile((Dictionary<string, object>)args[0]);
                case "file:exportPng": return await ExportPngAsync((Dictionary<string, object>)args[0]);
                default: throw new InvalidOperationException("不支持的桌面操作：" + method);
            }
        }

        private object OpenWorkspace()
        {
            using (FolderBrowserDialog dialog = new FolderBrowserDialog { Description = "添加 Mermaid 项目文件夹", ShowNewFolderButton = true })
            {
                if (dialog.ShowDialog(this) != DialogResult.OK) return null;
                string rootPath = Path.GetFullPath(dialog.SelectedPath);
                AddWorkspaceRoot(rootPath);
                return WorkspaceSnapshot();
            }
        }

        private object RemoveWorkspace(string rootPath)
        {
            string resolved = Path.GetFullPath(rootPath);
            workspaceRoots.RemoveAll(item => string.Equals(item, resolved, StringComparison.OrdinalIgnoreCase));
            SyncWatchers();
            return WorkspaceSnapshot();
        }

        private string ReadFile(string filePath)
        {
            EnsureAllowed(filePath);
            return File.ReadAllText(filePath, Encoding.UTF8);
        }

        private object SaveFile(string filePath, string content)
        {
            EnsureAllowed(filePath);
            File.WriteAllText(filePath, content, new UTF8Encoding(false));
            return WorkspaceSnapshot();
        }

        private object RenameFile(string filePath, string newName)
        {
            EnsureAllowed(filePath);
            string sourcePath = Path.GetFullPath(filePath);
            if (!File.Exists(sourcePath)) throw new FileNotFoundException("要重命名的文件已不存在", sourcePath);
            if (!sourcePath.EndsWith(".md", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("只能重命名 Markdown 文件");
            string fileName = StrictMarkdownName(newName);
            string destinationPath = Path.Combine(Path.GetDirectoryName(sourcePath), fileName);
            if (string.Equals(sourcePath, destinationPath, StringComparison.Ordinal))
                return new Dictionary<string, object> { ["filePath"] = sourcePath, ["snapshot"] = WorkspaceSnapshot() };
            if (File.Exists(destinationPath) && !string.Equals(sourcePath, destinationPath, StringComparison.OrdinalIgnoreCase))
                throw new IOException("已存在同名文件“" + fileName + "”，请换一个名字");

            if (string.Equals(sourcePath, destinationPath, StringComparison.OrdinalIgnoreCase))
            {
                string temporaryPath = Path.Combine(Path.GetDirectoryName(sourcePath), ".mermaid-studio-rename-" + Guid.NewGuid().ToString("N") + ".tmp");
                File.Move(sourcePath, temporaryPath);
                try { File.Move(temporaryPath, destinationPath); }
                catch
                {
                    if (File.Exists(temporaryPath) && !File.Exists(sourcePath)) File.Move(temporaryPath, sourcePath);
                    throw;
                }
            }
            else File.Move(sourcePath, destinationPath);

            return new Dictionary<string, object> { ["filePath"] = destinationPath, ["snapshot"] = WorkspaceSnapshot() };
        }

        private object CreateFile(string rootPath, string name, string content)
        {
            string root = Path.GetFullPath(rootPath);
            if (!workspaceRoots.Contains(root, StringComparer.OrdinalIgnoreCase)) throw new InvalidOperationException("请选择一个已打开的项目文件夹");
            string fileName = SafeMarkdownName(name, "new-diagram.md");
            string filePath = Path.Combine(root, fileName);
            try
            {
                WriteNewFile(filePath, content);
                return new Dictionary<string, object> { ["filePath"] = filePath, ["snapshot"] = WorkspaceSnapshot() };
            }
            catch (IOException)
            {
                if (File.Exists(filePath)) throw new IOException("已存在同名文件“" + fileName + "”，请换一个名字");
                throw;
            }
        }

        private object DeleteFile(string filePath)
        {
            EnsureAllowed(filePath);
            if (!filePath.EndsWith(".md", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("只能删除 Markdown 文件");
            File.Delete(filePath);
            return WorkspaceSnapshot();
        }

        private object SaveDraft(string suggestedName, string content, string preferredRootPath)
        {
            string rootPath = null;
            if (!string.IsNullOrWhiteSpace(preferredRootPath))
            {
                string preferred = Path.GetFullPath(preferredRootPath);
                if (workspaceRoots.Contains(preferred, StringComparer.OrdinalIgnoreCase)) rootPath = preferred;
            }
            if (rootPath == null)
            {
                using (FolderBrowserDialog dialog = new FolderBrowserDialog { Description = "选择保存 Mermaid 文件的文件夹", ShowNewFolderButton = true })
                {
                    if (dialog.ShowDialog(this) != DialogResult.OK) return null;
                    rootPath = Path.GetFullPath(dialog.SelectedPath);
                }
                AddWorkspaceRoot(rootPath);
            }

            string fileName = SafeMarkdownName(suggestedName, "untitled.md");
            string filePath = Path.Combine(rootPath, fileName);
            try
            {
                WriteNewFile(filePath, content);
                return new Dictionary<string, object> { ["filePath"] = filePath, ["rootPath"] = rootPath, ["snapshot"] = WorkspaceSnapshot() };
            }
            catch (IOException)
            {
                if (File.Exists(filePath)) throw new IOException("已存在同名文件“" + fileName + "”，请修改文件名后再保存");
                throw;
            }
        }

        private bool ExportFile(Dictionary<string, object> payload)
        {
            string type = Convert.ToString(payload["type"]);
            string suggestedName = Convert.ToString(payload["suggestedName"]);
            string filter = type == "png" ? "PNG 图片|*.png" : type == "svg" ? "SVG 矢量图|*.svg" : "Markdown|*.md";
            using (SaveFileDialog dialog = new SaveFileDialog { Title = "导出图表", FileName = suggestedName, Filter = filter, AddExtension = true })
            {
                if (dialog.ShowDialog(this) != DialogResult.OK) return false;
                string data = Convert.ToString(payload["data"]);
                if (Convert.ToString(payload["encoding"]) == "base64") File.WriteAllBytes(dialog.FileName, Convert.FromBase64String(data));
                else File.WriteAllText(dialog.FileName, data, new UTF8Encoding(false));
                return true;
            }
        }

        private async Task<bool> ExportPngAsync(Dictionary<string, object> payload)
        {
            string suggestedName = Convert.ToString(payload["suggestedName"]);
            string svg = Convert.ToString(payload["svg"]);
            double sourceWidth = Math.Max(1, Convert.ToDouble(payload["width"]));
            double sourceHeight = Math.Max(1, Convert.ToDouble(payload["height"]));
            double scale = Math.Max(1, Math.Min(2, Math.Min(8192 / sourceWidth, 8192 / sourceHeight)));
            int pixelWidth = Math.Max(1, (int)Math.Round(sourceWidth * scale));
            int pixelHeight = Math.Max(1, (int)Math.Round(sourceHeight * scale));

            using (SaveFileDialog dialog = new SaveFileDialog { Title = "导出高清 PNG", FileName = suggestedName, Filter = "PNG 图片|*.png", AddExtension = true })
            {
                if (dialog.ShowDialog(this) != DialogResult.OK) return false;
                await RenderSvgToPngAsync(svg, pixelWidth, pixelHeight, dialog.FileName);
                return true;
            }
        }

        private async Task RenderSvgToPngAsync(string svg, int pixelWidth, int pixelHeight, string outputPath)
        {
            using (Form renderForm = new Form())
            using (WebView2 renderer = new WebView2())
            {
                renderForm.Text = "Mermaid Studio PNG Renderer";
                renderForm.ShowInTaskbar = false;
                renderForm.FormBorderStyle = FormBorderStyle.None;
                renderForm.StartPosition = FormStartPosition.Manual;
                renderForm.Location = Location;
                renderForm.ClientSize = new Size(pixelWidth, pixelHeight);
                renderForm.Opacity = 0.01;
                renderForm.AutoScaleMode = AutoScaleMode.None;
                renderer.Dock = DockStyle.Fill;
                renderer.DefaultBackgroundColor = Color.White;
                renderForm.Controls.Add(renderer);
                renderForm.Show(this);
                try
                {
                    await renderer.EnsureCoreWebView2Async(webView.CoreWebView2.Environment);
                    renderer.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                    renderer.CoreWebView2.Settings.AreDevToolsEnabled = false;
                    renderer.ZoomFactor = 1;
                    TaskCompletionSource<bool> ready = new TaskCompletionSource<bool>();
                    renderer.CoreWebView2.NavigationCompleted += (_, args) =>
                    {
                        if (args.IsSuccess) ready.TrySetResult(true);
                        else ready.TrySetException(new InvalidOperationException("PNG 渲染页面加载失败：" + args.WebErrorStatus));
                    };
                    string html = "<!doctype html><html><head><meta charset=\"utf-8\"><style>html,body{width:100%;height:100%;margin:0;overflow:hidden;background:#fff}svg{display:block;width:100%!important;height:100%!important;max-width:none!important}</style></head><body>" + svg + "</body></html>";
                    renderer.CoreWebView2.NavigateToString(html);
                    Task completed = await Task.WhenAny(ready.Task, Task.Delay(15000));
                    if (completed != ready.Task) throw new TimeoutException("PNG 渲染超时");
                    await ready.Task;
                    await Task.Delay(80);
                    using (FileStream stream = new FileStream(outputPath, FileMode.Create, FileAccess.Write, FileShare.None))
                    {
                        await renderer.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, stream);
                    }
                }
                finally
                {
                    renderForm.Close();
                }
            }
        }

        private Dictionary<string, object> WorkspaceSnapshot()
        {
            List<object> folders = new List<object>();
            List<Dictionary<string, object>> recognized = new List<Dictionary<string, object>>();
            foreach (string rootPath in workspaceRoots.ToArray())
            {
                string rootName = new DirectoryInfo(rootPath).Name;
                ScanResult result = ScanDirectory(rootPath, rootPath, rootName, "", new Counter());
                Dictionary<string, object> folder = new Dictionary<string, object>
                {
                    ["rootPath"] = rootPath, ["rootName"] = rootName, ["tree"] = result.Tree.ToArray(), ["recognized"] = result.Recognized.ToArray()
                };
                folders.Add(folder);
                recognized.AddRange(result.Recognized);
            }
            return new Dictionary<string, object>
            {
                ["folders"] = folders.ToArray(),
                ["recognized"] = recognized.OrderByDescending(item => Convert.ToInt64(item["updatedAt"])).Cast<object>().ToArray()
            };
        }

        private ScanResult ScanDirectory(string directoryPath, string rootPath, string rootName, string relativePath, Counter counter)
        {
            ScanResult result = new ScanResult();
            if (counter.Value > 3000) return result;
            FileSystemInfo[] entries;
            try
            {
                entries = new DirectoryInfo(directoryPath).GetFileSystemInfos()
                    .OrderBy(item => item is DirectoryInfo ? 0 : 1)
                    .ThenBy(item => item.Name, StringComparer.CurrentCultureIgnoreCase).ToArray();
            }
            catch { return result; }

            foreach (FileSystemInfo entry in entries)
            {
                if (counter.Value++ > 3000) break;
                if (entry is DirectoryInfo directory)
                {
                    if (directory.Name.StartsWith(".") || SkippedDirectories.Contains(directory.Name)) continue;
                    string childRelative = string.IsNullOrEmpty(relativePath) ? directory.Name : Path.Combine(relativePath, directory.Name);
                    ScanResult child = ScanDirectory(directory.FullName, rootPath, rootName, childRelative, counter);
                    if (child.Tree.Count == 0) continue;
                    result.Tree.Add(new Dictionary<string, object>
                    {
                        ["kind"] = "directory", ["name"] = directory.Name, ["path"] = directory.FullName, ["relativePath"] = childRelative, ["children"] = child.Tree.ToArray()
                    });
                    result.Recognized.AddRange(child.Recognized);
                    continue;
                }

                if (!entry.Name.EndsWith(".md", StringComparison.OrdinalIgnoreCase)) continue;
                string fileRelative = string.IsNullOrEmpty(relativePath) ? entry.Name : Path.Combine(relativePath, entry.Name);
                result.Tree.Add(new Dictionary<string, object>
                {
                    ["kind"] = "file", ["name"] = entry.Name, ["path"] = entry.FullName, ["relativePath"] = fileRelative
                });
                try
                {
                    string content = File.ReadAllText(entry.FullName, Encoding.UTF8);
                    string type = DiagramTypeFromFirstLine(content);
                    if (type != null)
                    {
                        long updatedAt = (long)(File.GetLastWriteTimeUtc(entry.FullName) - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
                        result.Recognized.Add(new Dictionary<string, object>
                        {
                            ["path"] = entry.FullName, ["relativePath"] = fileRelative, ["name"] = entry.Name,
                            ["rootPath"] = rootPath, ["rootName"] = rootName, ["type"] = type, ["updatedAt"] = updatedAt
                        });
                    }
                }
                catch { }
            }
            return result;
        }

        private static string DiagramTypeFromFirstLine(string content)
        {
            string firstLine = Regex.Split(content ?? "", "\\r?\\n").FirstOrDefault()?.Trim().ToLowerInvariant() ?? "";
            Match tagged = Regex.Match(firstLine, @"^%%\s*type\s*:\s*(flowchart|sequence|class|state|er|gantt)\s*$", RegexOptions.IgnoreCase);
            if (tagged.Success) return tagged.Groups[1].Value.ToLowerInvariant();
            if (Regex.IsMatch(firstLine, @"^(flowchart|graph)(\s|$)")) return "flowchart";
            if (Regex.IsMatch(firstLine, @"^sequencediagram(\s|$)")) return "sequence";
            if (Regex.IsMatch(firstLine, @"^classdiagram(\s|$)")) return "class";
            if (Regex.IsMatch(firstLine, @"^statediagram(?:-v2)?(\s|$)")) return "state";
            if (Regex.IsMatch(firstLine, @"^erdiagram(\s|$)")) return "er";
            if (Regex.IsMatch(firstLine, @"^gantt(\s|$)")) return "gantt";
            return null;
        }

        private void SyncWatchers()
        {
            foreach (string root in watchers.Keys.Where(root => !workspaceRoots.Contains(root, StringComparer.OrdinalIgnoreCase)).ToArray())
            {
                watchers[root].Dispose();
                watchers.Remove(root);
            }
            foreach (string root in workspaceRoots)
            {
                if (watchers.ContainsKey(root) || !Directory.Exists(root)) continue;
                try
                {
                    FileSystemWatcher watcher = new FileSystemWatcher(root)
                    {
                        IncludeSubdirectories = true,
                        NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName | NotifyFilters.LastWrite | NotifyFilters.Size,
                        EnableRaisingEvents = true
                    };
                    watcher.Changed += (_, __) => ScheduleRefresh();
                    watcher.Created += (_, __) => ScheduleRefresh();
                    watcher.Deleted += (_, __) => ScheduleRefresh();
                    watcher.Renamed += (_, __) => ScheduleRefresh();
                    watcher.Error += (_, __) => ScheduleRefresh();
                    watchers[root] = watcher;
                }
                catch (Exception error)
                {
                    LogError("watcher:" + root, error);
                }
            }
        }

        private void ScheduleRefresh()
        {
            if (IsDisposed || !IsHandleCreated) return;
            try { BeginInvoke((Action)(() => { refreshTimer.Stop(); refreshTimer.Start(); })); }
            catch (InvalidOperationException) { }
        }

        private async Task BroadcastWorkspaceSnapshotAsync()
        {
            if (refreshRunning) { refreshQueued = true; return; }
            refreshRunning = true;
            try
            {
                PostJson(new Dictionary<string, object> { ["kind"] = "workspace:changed", ["snapshot"] = WorkspaceSnapshot() });
                await Task.Yield();
            }
            finally
            {
                refreshRunning = false;
                if (refreshQueued) { refreshQueued = false; ScheduleRefresh(); }
            }
        }

        private void PostJson(object value)
        {
            if (webView.CoreWebView2 != null) webView.CoreWebView2.PostWebMessageAsJson(serializer.Serialize(value));
        }

        private void EnsureAllowed(string targetPath)
        {
            string fullPath = Path.GetFullPath(targetPath);
            if (!workspaceRoots.Any(root => IsInsideRoot(root, fullPath))) throw new UnauthorizedAccessException("该文件不在已打开的项目中");
        }

        private static bool IsInsideRoot(string rootPath, string targetPath)
        {
            string root = Path.GetFullPath(rootPath).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            string target = Path.GetFullPath(targetPath);
            return target.StartsWith(root, StringComparison.OrdinalIgnoreCase);
        }

        private static string SafeMarkdownName(string name, string fallback)
        {
            string fileName = Path.GetFileName(name ?? "");
            foreach (char invalid in Path.GetInvalidFileNameChars()) fileName = fileName.Replace(invalid, '-');
            if (string.IsNullOrWhiteSpace(fileName) || fileName == ".md") fileName = fallback;
            return fileName.EndsWith(".md", StringComparison.OrdinalIgnoreCase) ? fileName : fileName + ".md";
        }

        private static string StrictMarkdownName(string name)
        {
            string candidate = (name ?? "").Trim();
            if (string.IsNullOrWhiteSpace(candidate) || candidate == ".md") throw new InvalidOperationException("文件名不能为空");
            if (!string.Equals(candidate, Path.GetFileName(candidate), StringComparison.Ordinal) || candidate.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
                throw new InvalidOperationException("文件名包含 Windows 不允许的字符");
            string fileName = candidate.EndsWith(".md", StringComparison.OrdinalIgnoreCase) ? candidate : candidate + ".md";
            if (fileName.Length > 180) throw new InvalidOperationException("文件名过长，请缩短后再试");
            return fileName;
        }

        private static Rectangle InitialWindowBounds(Rectangle workingArea)
        {
            int width = Math.Min(workingArea.Width, Math.Max(880, (int)Math.Round(workingArea.Width * 0.8)));
            int height = Math.Min(workingArea.Height, Math.Max(600, (int)Math.Round(workingArea.Height * 0.8)));
            return new Rectangle(
                workingArea.Left + (workingArea.Width - width) / 2,
                workingArea.Top + (workingArea.Height - height) / 2,
                width,
                height);
        }

        private static void WriteNewFile(string filePath, string content)
        {
            using (FileStream stream = new FileStream(filePath, FileMode.CreateNew, FileAccess.Write, FileShare.Read))
            using (StreamWriter writer = new StreamWriter(stream, new UTF8Encoding(false))) writer.Write(content ?? "");
        }

        private static string Arg(object[] args, int index) => Convert.ToString(args[index]);
        private static string ArgOrNull(object[] args, int index) => index < args.Length && args[index] != null ? Convert.ToString(args[index]) : null;

        private void AddWorkspaceRoot(string rootPath)
        {
            string resolved = Path.GetFullPath(rootPath);
            if (!Directory.Exists(resolved)) throw new DirectoryNotFoundException("所选文件夹不存在或当前无法访问");
            if (!workspaceRoots.Contains(resolved, StringComparer.OrdinalIgnoreCase)) workspaceRoots.Add(resolved);
            SyncWatchers();
        }

        private static object[] NormalizeArguments(object rawArguments)
        {
            if (rawArguments == null) return new object[0];
            if (rawArguments is object[] array) return array;
            if (rawArguments is ArrayList list) return list.Cast<object>().ToArray();
            if (rawArguments is IEnumerable enumerable) return enumerable.Cast<object>().ToArray();
            throw new InvalidOperationException("桌面请求参数格式无效");
        }

        private static void LogError(string context, Exception error)
        {
            try
            {
                Directory.CreateDirectory(LogDirectory);
                File.AppendAllText(LogPath, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + " [" + context + "]\r\n" + error + "\r\n\r\n", Encoding.UTF8);
            }
            catch { }
        }

        private void DisposeWatchers()
        {
            refreshTimer.Stop();
            foreach (FileSystemWatcher watcher in watchers.Values) watcher.Dispose();
            watchers.Clear();
        }

        private sealed class Counter { public int Value; }
        private sealed class ScanResult
        {
            public readonly List<Dictionary<string, object>> Tree = new List<Dictionary<string, object>>();
            public readonly List<Dictionary<string, object>> Recognized = new List<Dictionary<string, object>>();
        }
    }
}
