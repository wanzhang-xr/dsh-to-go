// dsh-to-go.exe —— 极小的启动器外壳（shim）
// -----------------------------------------------------------------------------
// 只做三件事：
//   1. 找 runtime\electron\dist\electron.exe，有就把它拉起来（桌面壳在 tools\electron\main.js）
//   2. 没有 Electron（比如盘没构建完）就退回 dsh-ui.cmd —— 浏览器路径永远是最后一道保险
//   3. 全程不碰任何凭据：不读密钥、不写令牌、不加命令行参数
//
// 为什么要有这一层：Electron 解包后是一大堆文件（几百 MB），而仓库根目录约定只放
// dsh-to-go.exe / dsh-ui.cmd / build.cmd 三个文件。所以根目录留这个小 exe 当入口，
// Electron 本体放在 runtime\electron\（不进 git，构建时下载）。
//
// 用系统自带 csc.exe 编译（不需要 .NET SDK）：
//   tools\launcher\build-launcher.cmd

using System;
using System.Diagnostics;
using System.IO;
using System.Text;

internal static class Shim
{
    private static string Root
    {
        get
        {
            string dir = AppDomain.CurrentDomain.BaseDirectory;
            return dir.TrimEnd(Path.DirectorySeparatorChar);
        }
    }

    private static void Log(string message)
    {
        try
        {
            string logs = Path.Combine(Root, "data", "logs");
            Directory.CreateDirectory(logs);
            string line = "[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "] shim: " + message + "\r\n";
            File.AppendAllText(Path.Combine(logs, "launcher.log"), line, Encoding.UTF8);
        }
        catch (Exception)
        {
            // 日志写不了不影响启动
        }
    }

    [STAThread]
    private static int Main()
    {
        string electron = Path.Combine(Root, "runtime", "electron", "node_modules", "electron", "dist", "electron.exe");
        string appDir = Path.Combine(Root, "tools", "electron");
        string node = Path.Combine(Root, "runtime", "node", "node.exe");
        string fallback = Path.Combine(Root, "dsh-ui.cmd");

        if (File.Exists(electron) && File.Exists(Path.Combine(appDir, "main.js")) && File.Exists(node))
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(electron, "\"" + appDir + "\"");
                psi.WorkingDirectory = Root;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                Process p = Process.Start(psi);
                Log("electron started (pid " + (p == null ? 0 : p.Id) + ")");
                return 0;
            }
            catch (Exception ex)
            {
                Log("electron start failed: " + ex.Message + " —— 回退 dsh-ui.cmd");
            }
        }
        else
        {
            Log("electron 未就绪（runtime\\electron 或 tools\\electron 缺失）—— 回退 dsh-ui.cmd");
        }

        if (File.Exists(fallback))
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo("cmd.exe", "/c start \"\" \"" + fallback + "\"");
                psi.WorkingDirectory = Root;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                Process.Start(psi);
                Log("fallback started: dsh-ui.cmd");
                return 0;
            }
            catch (Exception ex)
            {
                Log("fallback failed: " + ex.Message);
            }
        }

        // 两条路都不通：给一句人话，别让窗口一闪就没了
        System.Windows.Forms.MessageBox.Show(
            "没找到可用的运行环境。\r\n\r\n"
            + "· 桌面壳需要 runtime\\electron（首次请跑 build.cmd 下载）\r\n"
            + "· 浏览器路径需要 dsh-ui.cmd 与 runtime\\node\r\n\r\n"
            + "诊断日志：data\\logs\\launcher.log",
            "dsh-to-go 启动失败",
            System.Windows.Forms.MessageBoxButtons.OK,
            System.Windows.Forms.MessageBoxIcon.Warning);
        return 1;
    }
}
