// noai-vault.exe: the one program the NOAI Store package starts.
//
// It runs the bundled Node (signed by the OpenJS Foundation) on the vault's own
// command line, src/vault-cli.ts, passing every argument through untouched.
//   - From the Start menu (no arguments) it starts the vault for agents: "serve".
//   - From a terminal, "noai-vault add ...", "noai-vault receipts" and so on.
// The vault lives in %USERPROFILE%\.noai unless NOAI_HOME says otherwise, so it
// survives reinstalling the app and is never inside the package's own folder.
//
// Built by packaging/msix/build.ts with the C# compiler that ships with Windows.
using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;

static class Launcher
{
    static int Main(string[] argv)
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        string node = Path.Combine(dir, "node", "node.exe");
        string cli = Path.Combine(dir, "app", "src", "vault-cli.ts");
        bool fromStartMenu = argv.Length == 0;
        string[] args = fromStartMenu ? new[] { "serve" } : argv;

        var psi = new ProcessStartInfo(node)
        {
            UseShellExecute = false,
            Arguments = Quote(cli) + " " + string.Join(" ", args.Select(Quote).ToArray()),
        };
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("NOAI_HOME")))
        {
            psi.EnvironmentVariables["NOAI_HOME"] = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".noai");
        }

        // Ctrl+C reaches Node too. Wait for it, so it can lock the vault and wipe temporary files.
        Console.CancelKeyPress += (s, e) => { e.Cancel = true; };

        int code;
        try
        {
            using (var p = Process.Start(psi))
            {
                p.WaitForExit();
                code = p.ExitCode;
            }
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("NOAI could not start: " + e.Message);
            code = 1;
        }

        if (fromStartMenu && code != 0)
        {
            Console.Error.WriteLine();
            Console.Error.WriteLine("Press Enter to close this window.");
            Console.ReadLine();
        }
        return code;
    }

    // Windows command-line quoting, so an argument with spaces or quotes reaches Node exactly as typed.
    static string Quote(string a)
    {
        if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return a;
        var sb = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in a)
        {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { sb.Append('\\', slashes * 2 + 1); sb.Append('"'); slashes = 0; continue; }
            sb.Append('\\', slashes);
            slashes = 0;
            sb.Append(c);
        }
        sb.Append('\\', slashes * 2);
        sb.Append('"');
        return sb.ToString();
    }
}
