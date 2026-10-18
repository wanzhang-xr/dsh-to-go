// dsh-to-go native launcher (WinForms + WebView2)
// -----------------------------------------------------------------------------
// Starts tools/ui-server.js on a free local port, captures the per-run token
// from its stdout, opens a native window, and hands the token to the page over
// the WebView2 message bridge.  The token is never written to disk, never put
// in the window title, never passed on a command line and never logged.
//
// Built with the in-box C# compiler (csc.exe, .NET Framework 4.x):
//   tools/launcher/build-launcher.cmd
// -----------------------------------------------------------------------------

using System;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace DshToGo
{
    internal static class Program
    {
        internal const string AppTitle = "dsh-to-go";

        private static Mutex _instanceMutex;

        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();

        // WebView2 的两个托管程序集与一个原生 loader 放在 third_party\webview2\，
        // 根目录只留一个 exe。这里在加载任何 WebView2 类型之前把它们接上。
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool SetDllDirectory(string lpPathName);

        private static void HookWebView2Dependencies(string root)
        {
            string dir = System.IO.Path.Combine(root, "third_party", "webview2");
            if (!System.IO.Directory.Exists(dir)) return;
            try { SetDllDirectory(dir); } catch (Exception) { }
            AppDomain.CurrentDomain.AssemblyResolve += delegate(object sender, ResolveEventArgs args)
            {
                try
                {
                    string simple = new System.Reflection.AssemblyName(args.Name).Name;
                    string candidate = System.IO.Path.Combine(dir, simple + ".dll");
                    return System.IO.File.Exists(candidate) ? System.Reflection.Assembly.LoadFrom(candidate) : null;
                }
                catch (Exception) { return null; }
            };
        }

        [STAThread]
        private static void Main()
        {
            try { SetProcessDPIAware(); }
            catch (Exception) { }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            string root = Host.FindRoot();
            HookWebView2Dependencies(root);
            Host.Root = root;
            string key = Host.InstanceKey(root);

            bool isFirst;
            _instanceMutex = new Mutex(true, "dsh-to-go-launcher-" + key, out isFirst);

            if (!isFirst)
            {
                // Second launch: do not start another server.  Poke the running
                // instance through the named event and leave immediately.
                try
                {
                    using (EventWaitHandle ev = EventWaitHandle.OpenExisting("dsh-to-go-activate-" + key))
                    {
                        ev.Set();
                    }
                }
                catch (Exception) { }
                return;
            }

            try
            {
                Application.Run(new MainForm(root, key));
            }
            finally
            {
                GC.KeepAlive(_instanceMutex);
            }
        }
    }

    internal static class Host
    {
        internal static string Root = ".";

        // Matches "?token=<base64url>" printed by ui-server.js.  Group 1 is the
        // secret; it only ever lives in memory.
        internal static readonly Regex TokenPattern =
            new Regex(@"\?token=([A-Za-z0-9_-]+)", RegexOptions.CultureInvariant);

        internal static string FindRoot()
        {
            string dir = AppDomain.CurrentDomain.BaseDirectory;
            DirectoryInfo d = new DirectoryInfo(dir);
            for (int i = 0; i < 6 && d != null; i++)
            {
                if (File.Exists(Path.Combine(d.FullName, "tools", "ui-server.js")))
                {
                    return d.FullName;
                }
                d = d.Parent;
            }
            return Path.GetFullPath(Path.Combine(dir, "..", ".."));
        }

        internal static string InstanceKey(string root)
        {
            using (SHA1 sha = SHA1.Create())
            {
                byte[] hash = sha.ComputeHash(Encoding.UTF8.GetBytes(root.ToLowerInvariant()));
                StringBuilder sb = new StringBuilder();
                for (int i = 0; i < 6; i++)
                {
                    sb.Append(hash[i].ToString("x2", CultureInfo.InvariantCulture));
                }
                return sb.ToString();
            }
        }

        internal static string LogPath()
        {
            return Path.Combine(Root, "data", "logs", "launcher.log");
        }

        // Every line that leaves the process goes through Sanitize, so an
        // accidental token in a child's stderr can never reach the log file.
        internal static string Sanitize(string text)
        {
            if (string.IsNullOrEmpty(text)) return text;
            return TokenPattern.Replace(text, "?token=<redacted>");
        }

        internal static void Log(string message)
        {
            try
            {
                string path = LogPath();
                Directory.CreateDirectory(Path.GetDirectoryName(path));
                string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture)
                    + "  " + Sanitize(message) + Environment.NewLine;
                File.AppendAllText(path, line, new UTF8Encoding(false));
            }
            catch (Exception) { }
        }

        internal static int FindFreePort(int start)
        {
            for (int port = start; port < start + 200; port++)
            {
                TcpListener probe = null;
                try
                {
                    probe = new TcpListener(IPAddress.Loopback, port);
                    probe.Start();
                    return port;
                }
                catch (SocketException) { }
                finally
                {
                    if (probe != null)
                    {
                        try { probe.Stop(); }
                        catch (Exception) { }
                    }
                }
            }
            throw new InvalidOperationException("no free loopback port in range");
        }

        internal static string Quote(string value)
        {
            return "\"" + value.TrimEnd('\\') + "\"";
        }
    }

    internal sealed class MainForm : Form
    {
        private const int SW_RESTORE = 9;

        // 原生标题栏默认是浅色的，和深色 Fluent 页面接在一起像两个应用。
        // 用 DWM 把标题栏/边框/文字染成页面的深色，视觉上就连成一片了。
        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

        // 深/浅两套标题栏颜色，跟着页面里的主题一起换。
        private static void PaintChrome(IntPtr hwnd, bool dark)
        {
            if (hwnd == IntPtr.Zero) return;
            int on = dark ? 1 : 0;
            // 20 = DWMWA_USE_IMMERSIVE_DARK_MODE（Win10 2004+）；19 是旧版编号
            if (DwmSetWindowAttribute(hwnd, 20, ref on, sizeof(int)) != 0)
            {
                DwmSetWindowAttribute(hwnd, 19, ref on, sizeof(int));
            }
            int caption = dark ? 0x001F1F1F : 0x00F3F5F9;   // 深：--colorNeutralBackground2 / 浅：--bg
            int text = dark ? 0x00FFFFFF : 0x00101828;      // 浅：--fg
            int border = dark ? 0x003D3D3D : 0x00C9D2DE;    // 深：--colorNeutralStroke3 / 浅：--border
            DwmSetWindowAttribute(hwnd, 35, ref caption, sizeof(int));  // DWMWA_CAPTION_COLOR（Win11）
            DwmSetWindowAttribute(hwnd, 36, ref text, sizeof(int));     // DWMWA_TEXT_COLOR
            DwmSetWindowAttribute(hwnd, 34, ref border, sizeof(int));   // DWMWA_BORDER_COLOR
        }

        private static void PaintDarkChrome(IntPtr hwnd)
        {
            PaintChrome(hwnd, true);
        }


        // ================= 自绘标题栏所需的窗口行为 =================
        // 页面顶部 40px 画的是「应用自己的标题栏」，所以窗口必须无边框；
        // 但 FormBorderStyle.None 会把拖拽、缩放边、最大化边界一起拿掉，这里逐个补回来。
        private const int WM_NCHITTEST = 0x0084;
        private const int WM_GETMINMAXINFO = 0x0024;
        private const int HTCLIENT = 1, HTCAPTION = 2;
        private const int HTLEFT = 10, HTRIGHT = 11, HTTOP = 12, HTTOPLEFT = 13, HTTOPRIGHT = 14;
        private const int HTBOTTOM = 15, HTBOTTOMLEFT = 16, HTBOTTOMRIGHT = 17;
        // 下面这两个数字必须和页面 CSS 的 header 高度 / 三颗按钮总宽保持一致
        private const int TitleBarHeight = 44;   // 与页面 header 的高度一致
        private const int CaptionButtonsWidth = 138;
        private const int ResizeBorder = 4;
        // 页面量出来的「可拖动区右边界」（#tb-actions 的左边缘，像素）。
        // -1 = 还没收到，先用「窗口宽 - 138」兜底，保证按钮永远可点。
        private int _captionRight = -1;
        // 构造期设置 Size 会触发 OnResize，那时还没读回上次的尺寸；
        // 没有这个闸门就会先把默认值写回文件、把记忆覆盖掉（踩过）。
        private bool _stateReady;
        // 内容缩放：窗口越宽，整套 UI（字/卡片/按钮）一起放大，而不是只拉宽留白。
        // 基准 1180 CSS px —— 1280 的窗口约 1.08，1920 约 1.6，最小 0.8、最大 1.75。
        // 内容缩放基准宽度（页面用，宿主只做命中测试换算保持 1:1）
        private double _zoom = 1.0;

        [StructLayout(LayoutKind.Sequential)]
        private struct WINPOINT { public int X; public int Y; }
        [StructLayout(LayoutKind.Sequential)]
        private struct WINRECT { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)]
        private struct MINMAXINFO
        {
            public WINPOINT ptReserved, ptMaxSize, ptMaxPosition, ptMinTrackSize, ptMaxTrackSize;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct MONITORINFO
        {
            public int cbSize; public WINRECT rcMonitor; public WINRECT rcWork; public int dwFlags;
        }
        [DllImport("user32.dll")] private static extern bool GetCursorPos(out WINPOINT p);
        [DllImport("user32.dll")] private static extern bool ReleaseCapture();
        [DllImport("user32.dll")] private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] private static extern IntPtr MonitorFromWindow(IntPtr hwnd, int flags);
        [DllImport("user32.dll")] private static extern bool GetMonitorInfo(IntPtr hmon, ref MONITORINFO mi);

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_NCHITTEST)
            {
                base.WndProc(ref m);
                if ((int)m.Result != HTCLIENT) return;   // 系统控件（如菜单）优先
                // 用消息里的屏幕坐标（标准做法），而不是再问一次鼠标位置：
                // 拖动过程中坐标才连续，也方便用 SendMessage 做命中测试。
                int lp = m.LParam.ToInt32();
                int sx = (short)(lp & 0xFFFF);
                int sy = (short)((lp >> 16) & 0xFFFF);
                Point cp = PointToClient(new Point(sx, sy));
                int w = ClientSize.Width, h = ClientSize.Height;
                if (WindowState != FormWindowState.Maximized)
                {
                    bool left = cp.X < ResizeBorder, right = cp.X >= w - ResizeBorder;
                    bool top = cp.Y < ResizeBorder, bottom = cp.Y >= h - ResizeBorder;
                    if (top && left) { m.Result = (IntPtr)HTTOPLEFT; return; }
                    if (top && right) { m.Result = (IntPtr)HTTOPRIGHT; return; }
                    if (bottom && left) { m.Result = (IntPtr)HTBOTTOMLEFT; return; }
                    if (bottom && right) { m.Result = (IntPtr)HTBOTTOMRIGHT; return; }
                    if (left) { m.Result = (IntPtr)HTLEFT; return; }
                    if (right) { m.Result = (IntPtr)HTRIGHT; return; }
                    if (top) { m.Result = (IntPtr)HTTOP; return; }
                    if (bottom) { m.Result = (IntPtr)HTBOTTOM; return; }
                }
                // 顶栏靠左的部分＝标题栏：可拖、双击最大化；
                // 顶栏最右边 138px 留给页面里的三颗按钮，命中返回 HTCLIENT 让点击进网页。
                int dragRight = _captionRight > 0 ? _captionRight : w - CaptionButtonsWidth;
                int barH = TitleBarHeight;
                if (cp.Y < barH && cp.X < dragRight)
                {
                    m.Result = (IntPtr)HTCAPTION;
                }
                return;
            }
            if (m.Msg == WM_GETMINMAXINFO)
            {
                // 无边框窗口最大化会盖住任务栏，用工作区尺寸纠正
                base.WndProc(ref m);
                IntPtr hmon = MonitorFromWindow(Handle, 2);
                MONITORINFO mi = new MONITORINFO();
                mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
                if (GetMonitorInfo(hmon, ref mi))
                {
                    MINMAXINFO mmi = (MINMAXINFO)Marshal.PtrToStructure(m.LParam, typeof(MINMAXINFO));
                    mmi.ptMaxPosition.X = mi.rcWork.Left - mi.rcMonitor.Left;
                    mmi.ptMaxPosition.Y = mi.rcWork.Top - mi.rcMonitor.Top;
                    mmi.ptMaxSize.X = mi.rcWork.Right - mi.rcWork.Left;
                    mmi.ptMaxSize.Y = mi.rcWork.Bottom - mi.rcWork.Top;
                    Marshal.StructureToPtr(mmi, m.LParam, false);
                }
                return;
            }
            base.WndProc(ref m);
        }

        // 页面按钮 → 宿主：最小化 / 最大化还原 / 关闭（关闭走和原生关闭按钮一样的流程）
        private void ApplyZoom()
        {
            if (!_webReady || _web == null) return;
            try
            {
                int w = ClientSize.Width;
                if (w <= 0) return;
                // 缩放在页面里只作用于内容区（main），顶栏和菜单栏保持原尺寸。
                // 宿主这边只负责不变，避免把菜单也一起缩放。
                return;
            }
            catch (Exception ex) { Host.Log("zoom failed: " + ex.Message); }
        }

        private void PostWindowState()
        {
            if (!_webReady || _web == null || _web.CoreWebView2 == null) return;
            try
            {
                _web.CoreWebView2.PostWebMessageAsJson(
                    "{\"type\":\"dsh.win.state\",\"maximized\":" + (WindowState == FormWindowState.Maximized ? "true" : "false") + "}");
            }
            catch (Exception) { }
        }

        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            PostWindowState();
            ApplyZoom();
            if (WindowState == FormWindowState.Normal) SaveWindowState();
        }

        // ---- 窗口大小/位置记忆（data/window.json，跟着盘走）----
        private string WindowStateFile()
        {
            return Path.Combine(_root, "data", "window.json");
        }

        private void SaveWindowState()
        {
            try
            {
                if (!_stateReady) return;
                if (WindowState != FormWindowState.Normal) return;
                string dir = Path.Combine(_root, "data");
                Directory.CreateDirectory(dir);
                File.WriteAllText(WindowStateFile(),
                    "{\"w\":" + Width + ",\"h\":" + Height + ",\"x\":" + Left + ",\"y\":" + Top + "}");
            }
            catch (Exception) { }
        }

        private void LoadWindowState()
        {
            try
            {
                string f = WindowStateFile();
                if (!File.Exists(f)) return;
                string json = File.ReadAllText(f);
                int w = IntFromJson(json, "w"), h = IntFromJson(json, "h");
                int x = IntFromJson(json, "x"), y = IntFromJson(json, "y");
                if (w < 800 || h < 560) return;
                Size = new Size(w, h);
                Rectangle screen = Screen.FromPoint(new Point(x + w / 2, y + h / 2)).WorkingArea;
                if (x > screen.Left - 40 && y > screen.Top - 40
                    && x < screen.Right - 200 && y < screen.Bottom - 200)
                {
                    StartPosition = FormStartPosition.Manual;
                    Location = new Point(x, y);
                }
            }
            catch (Exception) { }
            finally { _stateReady = true; }
        }

        private static int IntFromJson(string json, string key)
        {
            int at = json.IndexOf("\"" + key + "\"", StringComparison.Ordinal);
            if (at < 0) return 0;
            int colon = json.IndexOf(':', at);
            if (colon < 0) return 0;
            int i = colon + 1;
            bool neg = false;
            while (i < json.Length && (json[i] == ' ' || json[i] == '-')) { if (json[i] == '-') neg = true; i++; }
            int start = i;
            while (i < json.Length && json[i] >= '0' && json[i] <= '9') i++;
            int v;
            if (i <= start || !int.TryParse(json.Substring(start, i - start), out v)) return 0;
            return neg ? -v : v;
        }


        // 无边框窗口默认没有 WS_MAXIMIZEBOX / WS_SYSMENU 这些位，
        // 系统就认为"这个窗口不能最大化"，于是双击标题栏（我们命中测试返回的 HTCAPTION）
        // 什么都不会发生。把位补回来：窗口边框依然不画（FormBorderStyle.None），
        // 但双击最大化、Alt+Space 系统菜单、拖到边缘 Snap 都恢复成系统原生行为。
        private const int WS_MAXIMIZEBOX = 0x00010000;
        private const int WS_MINIMIZEBOX = 0x00020000;
        private const int WS_SYSMENU = 0x00080000;

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.Style |= WS_MAXIMIZEBOX | WS_MINIMIZEBOX | WS_SYSMENU;
                return cp;
            }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            PaintDarkChrome(Handle);
            int round = 2;   // DWMWCP_ROUND：无边框窗口也要圆角
            DwmSetWindowAttribute(Handle, 33, ref round, sizeof(int));
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            PaintDarkChrome(Handle);   // 某些 DWM 主题在显示后才认颜色
        }

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        private readonly string _root;
        private readonly EventWaitHandle _activate;
        private readonly WebView2 _web = new WebView2();

        private Process _node;
        private bool _nodeStarted;
        private bool _fallbackDone;
        private bool _webReady;
        private bool _closed;
        private bool _probeDone;

        private int _port;
        private string _token;

        internal MainForm(string root, string key)
        {
            _root = root;
            _activate = new EventWaitHandle(false, EventResetMode.AutoReset,
                "dsh-to-go-activate-" + key);

            Text = Program.AppTitle;            // fixed; never contains the token
            // 图标 = dsh 官方 Windows 图标（assets\app.ico，由 tools/launcher/make-icon.js 从官方 SVG 生成）
            // 先用 assets 里的多尺寸 ico（窗口/Alt-Tab 各尺寸都清晰）；assets 不在（便携包被单独拷走）时
            // 再取 exe 自己内嵌的那一份，保证任何情况下都不是系统通用图标。
            bool gotIcon = false;
            try
            {
                string ico = Path.Combine(root, "assets", "app.ico");
                if (File.Exists(ico)) { Icon = new Icon(ico); gotIcon = true; }
            }
            catch (Exception) { /* 图标缺失不该阻止启动 */ }
            if (!gotIcon)
            {
                try
                {
                    Icon own = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
                    if (own != null) { Icon = own; gotIcon = true; }
                }
                catch (Exception) { /* 实在取不到就用系统默认 */ }
            }
            Size = new Size(1280, 860);
            StartPosition = FormStartPosition.CenterScreen;
            LoadWindowState();   // 上次的窗口大小/位置（没有就居中）
            MinimumSize = new Size(960, 660);
            // 无边框：标题栏由页面自己画（顶部 40px 是拖拽区，右侧 138px 是三个按钮），
            // 缩放边、最大化边界、双击最大化都在下面的 WndProc 里补回来。
            FormBorderStyle = FormBorderStyle.None;
            MainMenuStrip = null;               // no menu bar
            // 4px 缩放边的颜色＝顶栏颜色：视觉上顶栏一直铺到窗口边缘，三颗按钮才像"贴边"
            BackColor = Color.FromArgb(31, 31, 31);
            DoubleBuffered = true;

            // 关键：WebView2 是子窗口，会吃掉整块客户区的鼠标消息，窗体自己收不到 WM_NCHITTEST。
            // 留 4px 边距给窗体（颜色与页面同色，看起来像一条细边框），这 4px 才是真正的缩放热区。
            Padding = new Padding(4);
            _web.Dock = DockStyle.Fill;
            _web.DefaultBackgroundColor = Color.FromArgb(24, 26, 32);
            Controls.Add(_web);

            Shown += MainForm_Shown;
            FormClosing += MainForm_FormClosing;
            _web.CoreWebView2InitializationCompleted += Web_InitCompleted;

            Thread pump = new Thread(ActivationLoop);
            pump.IsBackground = true;
            pump.Name = "dsh-activate-wait";
            pump.Start();
        }

        private string UserDataFolder()
        {
            return Path.Combine(_root, "data", ".webview");
        }

        private void ActivationLoop()
        {
            while (!_closed)
            {
                if (_activate.WaitOne(400))
                {
                    if (_closed) return;
                    try { BeginInvoke(new Action(BringToFrontNow)); }
                    catch (Exception) { }
                }
            }
        }

        private void BringToFrontNow()
        {
            try
            {
                if (WindowState == FormWindowState.Minimized)
                {
                    WindowState = FormWindowState.Normal;
                }
                ShowWindow(Handle, SW_RESTORE);
                SetForegroundWindow(Handle);
                Activate();
            }
            catch (Exception) { }
        }

        private async void MainForm_Shown(object sender, EventArgs e)
        {
            string failure = null;
            try
            {
                await BootAsync();
            }
            catch (Exception ex)
            {
                Host.Log("boot failed: " + ex.GetType().Name + ": " + ex.Message);
                failure = ex.Message;
            }
            if (failure != null)
            {
                await ShowHtmlAsync(MessagePage("启动失败", "本地配置服务启动时出错：" + failure));
            }
        }

        private async Task BootAsync()
        {
            Directory.CreateDirectory(UserDataFolder());

            string nodeExe = Path.Combine(_root, "runtime", "node", "node.exe");
            string server = Path.Combine(_root, "tools", "ui-server.js");

            if (!File.Exists(nodeExe) || !File.Exists(server))
            {
                Host.Log("missing runtime: node=" + nodeExe + " exists=" + File.Exists(nodeExe)
                    + ", server exists=" + File.Exists(server));
                await ShowHtmlAsync(MessagePage("还没构建",
                    "没有找到 runtime\\node\\node.exe 或 tools\\ui-server.js。<br /><br />"
                    + "请先在启动盘根目录运行 <b>build.cmd</b> 完成构建，然后再双击这个启动器。<br /><br />"
                    + "（现在窗口里不会有配置页，也不会闪退。）"));
                return;
            }

            _port = Host.FindFreePort(3181);
            Host.Log("starting ui-server on 127.0.0.1:" + _port);
            StartServer(nodeExe, server, _port);

            if (_token == null)
            {
                Host.Log("ui-server printed no token within 30s");
                await ShowHtmlAsync(MessagePage("配置服务没起来",
                    "等了 30 秒也没拿到本地地址。请关掉窗口后重试，或直接运行 dsh-ui.cmd 排查。"));
                return;
            }
            Host.Log("token received (" + _token.Length + " chars)");
            // NOTE: only the length is logged above, never the token itself.

            bool ready = await WaitReadyAsync(_port, _token, 30000);
            if (!ready)
            {
                Host.Log("ui-server did not answer 200 within 30s");
                await ShowHtmlAsync(MessagePage("配置服务没响应",
                    "端口已打开但没有返回 200。请关掉窗口后重试。"));
                return;
            }
            Host.Log("ui-server ready");

            if (!await EnsureWebAsync())
            {
                return; // fallback already launched
            }

            string url = "http://127.0.0.1:" + _port.ToString(CultureInfo.InvariantCulture) + "/";
            _web.CoreWebView2.Navigate(url);
        }

        private void StartServer(string nodeExe, string server, int port)
        {
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = nodeExe;
            // The token is minted by the server itself; nothing secret is on this
            // command line.
            psi.Arguments = Host.Quote(server) + " --no-open --port "
                + port.ToString(CultureInfo.InvariantCulture);
            psi.WorkingDirectory = _root;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;
            // 把自己的 pid 交给服务：启动器被强杀（任务管理器 / taskkill /F）时，
            // ui-server 会在几秒内自己退出，不留孤儿服务。dsh 是独立子进程，
            // 不跟着死——和「关窗时选择后台继续」的语义一致。
            psi.EnvironmentVariables["DSH_LAUNCHER_PID"] =
                Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture);

            Process node = new Process();
            node.StartInfo = psi;
            node.EnableRaisingEvents = true;
            node.Exited += Node_Exited;

            try
            {
                node.Start();
            }
            catch (Exception ex)
            {
                Host.Log("cannot start node: " + ex.Message);
                return;
            }

            _node = node;
            _nodeStarted = true;

            ManualResetEventSlim got = new ManualResetEventSlim(false);
            StringBuilder buffer = new StringBuilder();

            node.OutputDataReceived += delegate(object s, DataReceivedEventArgs e)
            {
                if (e.Data == null) return;
                // stdout carries the token: it is parsed, never logged.
                lock (buffer)
                {
                    buffer.AppendLine(e.Data);
                    Match m = Host.TokenPattern.Match(buffer.ToString());
                    if (m.Success)
                    {
                        _token = m.Groups[1].Value;
                        got.Set();
                    }
                }
            };
            // Host.Log sanitizes, so a token in stderr cannot leak either.
            node.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e)
            {
                if (e.Data != null) Host.Log("ui-server stderr: " + e.Data);
            };

            node.BeginOutputReadLine();
            node.BeginErrorReadLine();
            got.Wait(30000);
        }

        private void Node_Exited(object sender, EventArgs e)
        {
            int code = -1;
            try { code = ((Process)sender).ExitCode; }
            catch (Exception) { }
            Host.Log("ui-server exited with code " + code);
        }

        private static async Task<bool> WaitReadyAsync(int port, string token, int timeoutMs)
        {
            using (HttpClient client = new HttpClient())
            {
                client.Timeout = TimeSpan.FromSeconds(5);
                client.DefaultRequestHeaders.Add("x-config-token", token);
                string url = "http://127.0.0.1:" + port.ToString(CultureInfo.InvariantCulture) + "/";
                Stopwatch sw = Stopwatch.StartNew();
                while (sw.ElapsedMilliseconds < timeoutMs)
                {
                    try
                    {
                        using (HttpResponseMessage resp = await client.GetAsync(url))
                        {
                            if ((int)resp.StatusCode == 200) return true;
                        }
                    }
                    catch (Exception) { }
                    await Task.Delay(300);
                }
                return false;
            }
        }

        private async Task<bool> EnsureWebAsync()
        {
            if (_webReady) return true;
            try
            {
                if (_web.CreationProperties == null)
                {
                    _web.CreationProperties = new CoreWebView2CreationProperties();
                }
                // Must be set BEFORE EnsureCoreWebView2Async.
                _web.CreationProperties.UserDataFolder = UserDataFolder();

                // Deliberately no CoreWebView2Environment.CreateAsync here: it
                // throws E_NOINTERFACE against the installed runtime.  Passing
                // null uses the default environment.
                await _web.EnsureCoreWebView2Async(null);

                ApplySettings(_web.CoreWebView2.Settings);
                _web.CoreWebView2.WebMessageReceived += Web_MessageReceived;
                _web.CoreWebView2.NavigationStarting += Web_NavigationStarting;
                _web.CoreWebView2.NewWindowRequested += Web_NewWindowRequested;
                _web.CoreWebView2.NavigationCompleted += Web_NavigationCompleted;

                // ui-server.js currently rejects even "/" without a token.  The
                // contract forbids putting it in the URL, so it rides along as a
                // request header on our own origin only (never on third-party
                // requests, so it cannot leak off-box).
                if (_port > 0)
                {
                    _web.CoreWebView2.AddWebResourceRequestedFilter(
                        "http://127.0.0.1:" + _port.ToString(CultureInfo.InvariantCulture) + "/*",
                        CoreWebView2WebResourceContext.All);
                    _web.CoreWebView2.WebResourceRequested += Web_ResourceRequested;
                }

                _webReady = true;
                Host.Log("webview2 ready");
                return true;
            }
            catch (Exception ex)
            {
                Host.Log("webview2 init failed: " + ex.GetType().Name + ": " + ex.Message);
                FallbackToCmd();
                return false;
            }
        }

        private void Web_InitCompleted(object sender, CoreWebView2InitializationCompletedEventArgs e)
        {
            if (e.IsSuccess)
            {
                try { ApplySettings(_web.CoreWebView2.Settings); }
                catch (Exception) { }
                return;
            }
            Host.Log("webview2 initialization completed with failure: "
                + (e.InitializationException == null ? "unknown" : e.InitializationException.Message));
            FallbackToCmd();
        }

        private static void ApplySettings(CoreWebView2Settings s)
        {
            s.AreDevToolsEnabled = false;
            s.AreDefaultContextMenusEnabled = false;
            s.AreBrowserAcceleratorKeysEnabled = false;
            // 自带缩放在 Ctrl+滚轮时会把顶栏和菜单栏一起放大；缩放改由页面只作用于内容区
            s.IsZoomControlEnabled = false;
            s.IsPasswordAutosaveEnabled = false;
            s.IsGeneralAutofillEnabled = false;
            s.AreDefaultScriptDialogsEnabled = false;
            s.IsStatusBarEnabled = false;
            s.AreHostObjectsAllowed = false;
        }

        /// <summary>
        /// 只放行我们自己的 origin：scheme=http、host=127.0.0.1、port=本次端口、
        /// 且不带 userinfo（否则 http://127.0.0.1:3181@evil.com 这种会被当成合法前缀）。
        /// about:blank 单独放行（NavigateToString 用）；data: 一律拒。
        /// </summary>
        private bool IsAllowedUri(string uri)
        {
            if (string.IsNullOrEmpty(uri)) return false;
            if (string.Equals(uri, "about:blank", StringComparison.OrdinalIgnoreCase)) return true;
            Uri u;
            if (!Uri.TryCreate(uri, UriKind.Absolute, out u)) return false;
            if (!string.Equals(u.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase)) return false;
            if (!string.Equals(u.Host, "127.0.0.1", StringComparison.OrdinalIgnoreCase)) return false;
            if (u.Port != _port) return false;
            if (!string.IsNullOrEmpty(u.UserInfo)) return false;
            return true;
        }

        private void Web_NavigationStarting(object sender, CoreWebView2NavigationStartingEventArgs e)
        {
            string uri = e.Uri == null ? string.Empty : e.Uri;
            if (!IsAllowedUri(uri))
            {
                e.Cancel = true;
                Host.Log("navigation blocked: " + uri);
            }
        }

        private void Web_NewWindowRequested(object sender, CoreWebView2NewWindowRequestedEventArgs e)
        {
            // 页面不会开新窗口；真被触发就拦掉，避免绕过上面的导航白名单
            e.Handled = true;
            Host.Log("new window blocked: " + (e.Uri == null ? string.Empty : e.Uri));
        }

        private async void Web_NavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            if (e.IsSuccess) Host.Log("page loaded");
            if (e.IsSuccess) PostWindowState();
            if (e.IsSuccess) ApplyZoom();
            else Host.Log("page load failed: " + e.WebErrorStatus);

            if (_probeDone) return;
            _probeDone = true;

            // Opt-in self test (DSH_LAUNCHER_SELFTEST=1): drives the real
            // WebMessageReceived -> PostWebMessageAsJson path and logs only the
            // message type and token *length*, never the token.
            if (Environment.GetEnvironmentVariable("DSH_LAUNCHER_SELFTEST") != "1") return;
            if (!_webReady) return;
            try
            {
                await _web.CoreWebView2.ExecuteScriptAsync(
                    "window.__dshProbe=null;"
                    + "window.chrome.webview.addEventListener('message',function(ev){window.__dshProbe=ev.data;});"
                    + "window.chrome.webview.postMessage({type:'dsh.token.request'});'sent'");
                await Task.Delay(600);
                string res = await _web.CoreWebView2.ExecuteScriptAsync(
                    "(function(){var p=window.__dshProbe;if(!p)return 'no-reply';"
                    + "return String(p.type)+' token-length='+String(p.token?p.token.length:0);})()");
                string dom = await _web.CoreWebView2.ExecuteScriptAsync(
                    "(function(){return 'title='+String(document.title)+' text-length='+"
                    + "String((document.body&&document.body.innerText||'').length);})()");
                Host.Log("selftest bridge: " + res + " | page " + dom);
            }
            catch (Exception ex)
            {
                Host.Log("selftest failed: " + ex.Message);
            }
        }

        private void Web_ResourceRequested(object sender, CoreWebView2WebResourceRequestedEventArgs e)
        {
            // Same-origin only: the filter above is narrow, and we double-check
            // the URI so the token can never be sent to anything but our server.
            if (_token == null || _port <= 0) return;
            string uri;
            try { uri = e.Request.Uri; }
            catch (Exception) { return; }
            string allowed = "http://127.0.0.1:" + _port.ToString(CultureInfo.InvariantCulture) + "/";
            if (uri == null || !uri.StartsWith(allowed, StringComparison.OrdinalIgnoreCase)) return;
            try
            {
                e.Request.Headers.SetHeader("x-config-token", _token);
            }
            catch (Exception) { }
        }

        /// <summary>
        /// 只接受本机 origin 发来的消息（e.Source 严格比对），并按 JSON 的 type 字段分发。
        /// 不做子串匹配：被加载进来的任何文档都无法靠拼字符串触发 PostToken()。
        /// </summary>
        private void Web_MessageReceived(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            if (!IsAllowedUri(e.Source))
            {
                Host.Log("message blocked: source=" + (e.Source == null ? "(null)" : e.Source));
                return;
            }

            string json;
            try { json = e.WebMessageAsJson; }
            catch (Exception) { return; }
            if (string.IsNullOrEmpty(json)) return;

            string type = ReadJsonString(json, "type");
            if (type == null) { Host.Log("message ignored: no type"); return; }

            switch (type)
            {
                case "dsh.token.request":
                    PostToken();
                    return;
                case "dsh.activate":
                    BringToFrontNow();
                    return;
                case "dsh.win.drag":
                    // 交给系统的非客户区拖动：双击最大化、贴边分屏、拖到顶部 Snap 都会自动生效
                    ReleaseCapture();
                    SendMessage(Handle, 0x00A1 /*WM_NCLBUTTONDOWN*/, (IntPtr)HTCAPTION, IntPtr.Zero);
                    return;
                case "dsh.win.hit":
                    {
                        int v = ReadJsonInt(json, "captionRight");
                        if (v > 0) _captionRight = v;
                        return;
                    }
                case "dsh.win.min":
                    WindowState = FormWindowState.Minimized;
                    return;
                case "dsh.win.max":
                    WindowState = WindowState == FormWindowState.Maximized
                        ? FormWindowState.Normal : FormWindowState.Maximized;
                    PostWindowState();
                    return;
                case "dsh.win.close":
                    BeginCloseFlow();
                    return;
                case "dsh.theme":
                    // 只认 light/dark 两个取值；标题文本永远是固定值，不受页面影响
                    ApplyTheme(string.Equals(ReadJsonString(json, "theme"), "light", StringComparison.OrdinalIgnoreCase));
                    return;
                default:
                    Host.Log("message ignored: type=" + type);
                    return;
            }
        }

        /// <summary>从 JSON 里取一个字符串字段（够用的极简解析：不依赖外部库）。</summary>
        private static string ReadJsonString(string json, string key)
        {
            int at = json.IndexOf("\"" + key + "\"", StringComparison.Ordinal);
            if (at < 0) return null;
            int colon = json.IndexOf(':', at + key.Length + 2);
            if (colon < 0) return null;
            int i = colon + 1;
            while (i < json.Length && char.IsWhiteSpace(json[i])) i++;
            if (i >= json.Length || json[i] != '"') return null;
            i++;
            StringBuilder sb = new StringBuilder();
            while (i < json.Length)
            {
                char c = json[i];
                if (c == '"') return sb.ToString();
                if (c == '\\' && i + 1 < json.Length)
                {
                    char n = json[i + 1];
                    if (n == 'u' && i + 5 < json.Length)
                    {
                        int code;
                        if (int.TryParse(json.Substring(i + 2, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out code)) sb.Append((char)code);
                        i += 6;
                        continue;
                    }
                    sb.Append(n == 'n' ? '\n' : n == 't' ? '\t' : n == 'r' ? '\r' : n);
                    i += 2;
                    continue;
                }
                sb.Append(c);
                i++;
            }
            return sb.ToString();
        }

        /// <summary>从 JSON 里取一个非负整数字段。</summary>
        private static int ReadJsonInt(string json, string key)
        {
            int at = json.IndexOf("\"" + key + "\"", StringComparison.Ordinal);
            if (at < 0) return 0;
            int colon = json.IndexOf(':', at + key.Length + 2);
            if (colon < 0) return 0;
            int i = colon + 1;
            while (i < json.Length && (json[i] == ' ' || json[i] == '	')) i++;
            int start = i;
            while (i < json.Length && json[i] >= '0' && json[i] <= '9') i++;
            int v;
            return (i > start && int.TryParse(json.Substring(start, i - start), out v)) ? v : 0;
        }

        private void ApplyTheme(bool light)
        {
            try
            {
                PaintChrome(Handle, !light);
                BackColor = light ? Color.FromArgb(250, 250, 250) : Color.FromArgb(31, 31, 31);
                // 底色跟着换，避免加载/重绘的瞬间露出白边（SDK 的这个属性在 WebView2 控件上）
                if (_web != null)
                {
                    _web.DefaultBackgroundColor = light
                        ? Color.FromArgb(243, 245, 249)
                        : Color.FromArgb(24, 26, 32);
                }
                Host.Log("theme=" + (light ? "light" : "dark"));
            }
            catch (Exception ex) { Host.Log("theme apply failed: " + ex.Message); }
        }

        private void PostToken()
        {
            if (_token == null || !_webReady) return;
            try
            {
                // base64url only, so no escaping is required.
                string payload = "{\"type\":\"dsh.token\",\"token\":\"" + _token + "\"}";
                _web.CoreWebView2.PostWebMessageAsJson(payload);
            }
            catch (Exception ex)
            {
                Host.Log("post token failed: " + ex.Message);
            }
        }

        private async Task ShowHtmlAsync(string html)
        {
            if (!await EnsureWebAsync()) return;   // fallback already launched
            _web.CoreWebView2.NavigateToString(html);
        }

        private void FallbackToCmd()
        {
            if (_fallbackDone) return;
            _fallbackDone = true;
            Host.Log("falling back to dsh-ui.cmd");
            try
            {
                BeginInvoke(new Action(delegate
                {
                    try { Close(); }
                    catch (Exception) { }
                    try
                    {
                        string cmd = Path.Combine(_root, "dsh-ui.cmd");
                        ProcessStartInfo psi = new ProcessStartInfo(cmd);
                        psi.UseShellExecute = true;
                        psi.WorkingDirectory = _root;
                        Process.Start(psi);
                    }
                    catch (Exception ex)
                    {
                        Host.Log("fallback start failed: " + ex.Message);
                    }
                }));
            }
            catch (Exception) { }
        }

        private static string MessagePage(string heading, string body)
        {
            return "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\" />"
                + "<title>dsh-to-go</title><style>"
                + "html,body{margin:0;height:100%;background:#181a20;color:#e7e9ee;"
                + "font-family:'Segoe UI','Microsoft YaHei',sans-serif;}"
                + ".box{max-width:640px;margin:0 auto;padding:72px 32px;line-height:1.75;}"
                + "h1{font-size:20px;font-weight:600;margin:0 0 18px;}"
                + "p{font-size:14px;color:#b9bfcc;margin:0 0 14px;}"
                + "code{background:#22252e;padding:2px 6px;border-radius:4px;color:#9ad1ff;}"
                + "</style></head><body><div class=\"box\"><h1>" + heading + "</h1><p>"
                + body + "</p></div></body></html>";
        }

        private bool _closeConfirmed;
        // 用户在关窗对话框里选了「让 dsh 继续在后台运行」：清理时只杀 ui-server（不带 /T）
        private bool _keepDshOnClose;
        private bool _closeFlowRunning;

        private void MainForm_FormClosing(object sender, FormClosingEventArgs e)
        {
            SaveWindowState();
            // 关窗要先问一次「dsh 要不要一起停」：不能在这里同步阻塞 UI 线程，
            // 所以先取消这次关闭，走完流程再真正关。
            if (!_closeConfirmed)
            {
                e.Cancel = true;
                BeginCloseFlow();
                return;
            }
            CleanupServer();
        }

        private void CleanupServer()
        {
            _closed = true;
            try { _activate.Set(); }
            catch (Exception) { }

            if (_nodeStarted && _node != null)
            {
                try
                {
                    if (!_node.HasExited)
                    {
                        int pid = _node.Id;
                        // keep 时不能用 /T：dsh 是 ui-server 的子孙进程（ui-server → launch.js → dsh），
                        // /T 会把它一起杀掉，那个「让 dsh 继续在后台运行」就成了空话。
                        string killArgs = _keepDshOnClose
                            ? "/F /PID " + pid.ToString(CultureInfo.InvariantCulture)
                            : "/F /T /PID " + pid.ToString(CultureInfo.InvariantCulture);
                        ProcessStartInfo psi = new ProcessStartInfo("taskkill", killArgs);
                        psi.UseShellExecute = false;
                        psi.CreateNoWindow = true;
                        psi.WindowStyle = ProcessWindowStyle.Hidden;
                        using (Process kill = Process.Start(psi))
                        {
                            if (kill != null) kill.WaitForExit(5000);
                        }
                        Host.Log("ui-server stopped (own pid " + pid + ( _keepDshOnClose ? ", dsh kept alive" : "" ) + ")");
                    }
                }
                catch (Exception ex)
                {
                    Host.Log("taskkill failed: " + ex.Message);
                }
            }
        }

        // ---------------------------------------------------------------- 关窗语义
        // 已解锁 + dsh 在跑 → 问一次「要不要一起停」（默认停）；
        // 未解锁 → 停不了（/api/dsh/stop 需要口令），如实告知并只关窗口。
        private async void BeginCloseFlow()
        {
            if (_closeFlowRunning) return;
            _closeFlowRunning = true;
            try
            {
                bool running = false;
                try { running = await DshRunningAsync(); }
                catch (Exception ex) { Host.Log("close: 状态查询失败: " + ex.Message); }

                if (running)
                {
                    bool? keep = AskCloseChoice();
                    if (keep == null) return;            // 取消：什么都不做
                    if (keep == false)
                    {
                        string err = await StopDshAsync();
                        if (err != null)
                        {
                            Host.Log("close: 停 dsh 失败: " + err);
                            MessageBox.Show(this,
                                "没能停掉 dsh：" + err + "\r\n\r\ndsh 会继续在后台运行；下次打开启动器还能看到它的状态。",
                                "dsh 仍在运行", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                        }
                        else Host.Log("close: dsh 已停止");
                    }
                    else
                    {
                        _keepDshOnClose = true;
                        Host.Log("close: 用户选择让 dsh 继续在后台运行");
                    }
                }
            }
            catch (Exception ex)
            {
                Host.Log("close flow failed: " + ex.Message);
            }
            finally
            {
                _closeFlowRunning = false;
            }
            _closeConfirmed = true;
            Close();
        }

        private async Task<bool> DshRunningAsync()
        {
            if (_port <= 0 || _token == null) return false;
            using (HttpClient c = new HttpClient())
            {
                c.Timeout = TimeSpan.FromSeconds(5);
                c.DefaultRequestHeaders.TryAddWithoutValidation("x-config-token", _token);
                string body = await c.GetStringAsync("http://127.0.0.1:"
                    + _port.ToString(CultureInfo.InvariantCulture) + "/api/state");
                Match m = Regex.Match(body, "\"dsh\"\\s*:\\s*\\{[\\s\\S]{0,600}?\"running\"\\s*:\\s*(true|false)");
                return m.Success && m.Groups[1].Value == "true";
            }
        }

        private async Task<string> StopDshAsync()
        {
            if (_port <= 0 || _token == null) return "没有本地服务地址";
            using (HttpClient c = new HttpClient())
            {
                c.Timeout = TimeSpan.FromSeconds(25);
                c.DefaultRequestHeaders.TryAddWithoutValidation("x-config-token", _token);
                HttpResponseMessage r = await c.PostAsync(
                    "http://127.0.0.1:" + _port.ToString(CultureInfo.InvariantCulture) + "/api/dsh/stop",
                    new StringContent("{}", Encoding.UTF8, "application/json"));
                string body = await r.Content.ReadAsStringAsync();
                if ((int)r.StatusCode == 200) return null;
                if ((int)r.StatusCode == 401) return "需要先在配置页里输入口令解锁（口令只在页面里输入，启动器不保存）";
                Match m = Regex.Match(body, "\"error\"\\s*:\\s*\"([^\"]*)\"");
                return m.Success ? m.Groups[1].Value : ("HTTP " + (int)r.StatusCode);
            }
        }

        /// <summary>返回 true=保持运行并关闭，false=停掉 dsh 并关闭，null=取消。</summary>
        private bool? AskCloseChoice()
        {
            using (Form dlg = new Form())
            {
                dlg.Text = "关闭启动器";
                dlg.FormBorderStyle = FormBorderStyle.FixedDialog;
                dlg.StartPosition = FormStartPosition.CenterParent;
                dlg.MinimizeBox = false;
                dlg.MaximizeBox = false;
                dlg.ShowInTaskbar = false;
                dlg.ClientSize = new Size(452, 196);
                dlg.BackColor = Color.FromArgb(41, 41, 41);
                dlg.ForeColor = Color.FromArgb(255, 255, 255);

                Label title = new Label();
                title.Text = "dsh 还在运行";
                title.Font = new Font("Segoe UI", 11F, FontStyle.Bold);
                title.AutoSize = true;
                title.Location = new Point(18, 16);
                dlg.Controls.Add(title);

                Label body = new Label();
                body.Text = "关掉启动器时，要不要连 dsh 一起停掉？（默认停掉，不留后台进程）";
                body.AutoSize = false;
                body.Size = new Size(416, 24);
                body.ForeColor = Color.FromArgb(214, 214, 214);
                body.Location = new Point(18, 48);
                dlg.Controls.Add(body);

                CheckBox keep = new CheckBox();
                keep.Text = "让 dsh 继续在后台运行（下次打开启动器还能看到它的状态）";
                keep.AutoSize = false;
                keep.Size = new Size(416, 40);
                keep.Location = new Point(18, 80);
                keep.Checked = false;
                dlg.Controls.Add(keep);

                Button close = new Button();
                close.Text = "关闭";
                close.Size = new Size(96, 32);
                close.Location = new Point(232, 140);
                close.DialogResult = DialogResult.OK;
                dlg.Controls.Add(close);

                Button cancel = new Button();
                cancel.Text = "取消";
                cancel.Size = new Size(96, 32);
                cancel.Location = new Point(338, 140);
                cancel.DialogResult = DialogResult.Cancel;
                dlg.Controls.Add(cancel);

                dlg.AcceptButton = close;
                dlg.CancelButton = cancel;

                DialogResult r = dlg.ShowDialog(this);
                if (r != DialogResult.OK) return null;
                return keep.Checked;
            }
        }
    }
}
