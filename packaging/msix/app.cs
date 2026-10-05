// NOAI.exe: what the Start menu opens. A normal Windows app: no terminal.
//
//   - starts NOAI's engine (the bundled, OpenJS-signed node.exe) hidden in the background
//   - opens the NOAI window: Microsoft Edge in app mode, so it looks like an app, not a browser
//   - puts the Lid in the tray by the clock: Open NOAI, Lock and quit
//   - a second click on NOAI just brings the window back
//
// The window gets a one-time key in its address so only it can drive the dashboard.
// Built by packaging/msix/build.ts with the C# compiler that ships with Windows.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Security.Cryptography;
using System.Threading;
using System.Windows.Forms;

static class NoaiApp
{
    const int Port = 7792;
    static Process engine;
    static string appUrl;
    static NotifyIcon tray;

    [STAThread]
    static void Main()
    {
        bool first;
        using (var running = new Mutex(true, "SilentKeyTechnologies.NOAI.App", out first))
        using (var show = new EventWaitHandle(false, EventResetMode.AutoReset, "SilentKeyTechnologies.NOAI.Show"))
        {
            if (!first) { show.Set(); return; }
            Application.EnableVisualStyles();

            string dir = AppDomain.CurrentDomain.BaseDirectory;
            byte[] k = new byte[24];
            using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(k);
            string uiToken = Convert.ToBase64String(k).Replace('+', '-').Replace('/', '_').TrimEnd('=');

            var psi = new ProcessStartInfo(Path.Combine(dir, "node", "node.exe"))
            {
                Arguments = "\"" + Path.Combine(dir, "app", "src", "vault-cli.ts") + "\" app --port " + Port + " --ui-token " + uiToken + " --ui \"" + Path.Combine(dir, "app", "dashboard") + "\"",
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = dir,
            };
            if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("NOAI_HOME")))
                psi.EnvironmentVariables["NOAI_HOME"] = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".noai");

            string problem = null;
            try
            {
                engine = Process.Start(psi);
                var ready = new ManualResetEvent(false);
                engine.OutputDataReceived += (s, e) => { if (e.Data != null && e.Data.StartsWith("NOAI_READY ")) { appUrl = e.Data.Substring(11).Trim(); ready.Set(); } };
                engine.ErrorDataReceived += (s, e) => { if (e.Data != null && e.Data.StartsWith("NOAI_ERROR ")) { problem = e.Data.Substring(11); ready.Set(); } };
                engine.BeginOutputReadLine();
                engine.BeginErrorReadLine();
                if (!ready.WaitOne(20000) && problem == null) problem = "NOAI did not start in time. Try opening it again.";
            }
            catch (Exception e) { problem = "NOAI could not start: " + e.Message; }

            if (problem != null || appUrl == null)
            {
                MessageBox.Show(problem ?? "NOAI could not start.", "NOAI", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                Stop();
                return;
            }

            tray = new NotifyIcon { Text = "NOAI: your agent vault", Visible = true, Icon = LoadIcon(dir) };
            var menu = new ContextMenuStrip();
            menu.Items.Add("Open NOAI", null, (s, e) => OpenWindow());
            menu.Items.Add("Lock and quit", null, (s, e) => { Stop(); Application.Exit(); });
            tray.ContextMenuStrip = menu;
            tray.DoubleClick += (s, e) => OpenWindow();

            // A second click on NOAI in the Start menu lands here.
            var ui = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
            ThreadPool.RegisterWaitForSingleObject(show, (o, t) => ui.Post(_ => OpenWindow(), null), null, -1, false);
            engine.EnableRaisingEvents = true;
            engine.Exited += (s, e) => ui.Post(_ => { if (tray != null) { tray.Visible = false; } Application.Exit(); }, null);

            OpenWindow();
            Application.Run();
            Stop();
        }
    }

    static void OpenWindow()
    {
        string[] edges = {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Microsoft", "Edge", "Application", "msedge.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Microsoft", "Edge", "Application", "msedge.exe"),
        };
        string profile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "NOAI", "window");
        foreach (var edge in edges)
        {
            if (!File.Exists(edge)) continue;
            Process.Start(new ProcessStartInfo(edge, "--app=" + appUrl + " --user-data-dir=\"" + profile + "\" --no-first-run --window-size=1280,860") { UseShellExecute = false });
            return;
        }
        Process.Start(new ProcessStartInfo(appUrl) { UseShellExecute = true });
    }

    static Icon LoadIcon(string dir)
    {
        try
        {
            using (var bmp = new Bitmap(Path.Combine(dir, "assets", "Square44x44Logo.scale-200.png")))
                return Icon.FromHandle(bmp.GetHicon());
        }
        catch { return SystemIcons.Shield; }
    }

    static void Stop()
    {
        try { if (tray != null) tray.Visible = false; } catch { }
        // Ending the engine ends the unlocked vault: its key lived only in that process.
        try { if (engine != null && !engine.HasExited) engine.Kill(); } catch { }
    }
}
